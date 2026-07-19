import * as vscode from 'vscode';

import { JSDOM } from 'jsdom';
import type { Token } from 'parse5';
import he from 'he';
import path from 'path';

interface SourceDomCache {
  dom: JSDOM;
  byStartOffset: Map<number, Element>;
}

export class VisualEditorProvider implements vscode.CustomTextEditorProvider {

  public activeCode: vscode.TextDocument | null = null;

  private editorOptions = { insertSpaces: true, indentSize: 2, indentChar: ' ', indentUnit: '  ' };
  private readonly context: vscode.ExtensionContext;
  private readonly codes = new Map<vscode.TextDocument, Set<vscode.WebviewPanel>>();
  private readonly editedBy = new Set<vscode.WebviewPanel>();
  private readonly resources = new Map<string, Set<vscode.TextDocument>>();
  private readonly sourceDoms = new Map<vscode.TextDocument, SourceDomCache>();

  constructor(private readonly ec: vscode.ExtensionContext) {
    this.context = ec;
    // Get and update indentation setting
    const editorConfig = vscode.workspace.getConfiguration('editor', { languageId: 'html' });
    const insertSpaces = editorConfig.get<boolean>('insertSpaces');
    const indentSize = editorConfig.get<number>('tabSize')!;
    Object.assign(this.editorOptions, {
      insertSpaces,
      indentSize,
      indentChar: insertSpaces ? ' ' : '\t',
      indentUnit: insertSpaces ? ' '.repeat(indentSize) : '\t'
    });
    vscode.window.onDidChangeVisibleTextEditors(editors => {
      const htmlEditor = editors.find(e => e.document.languageId === 'html');
      if (!htmlEditor) { return; }
      const options = htmlEditor.options;
      Object.assign(this.editorOptions, {
        insertSpaces: options.insertSpaces,
        indentSize: options.indentSize
      });
    });
    // Process when file save
    vscode.workspace.onDidSaveTextDocument(document => {
      this.resources.get(document.uri.fsPath)?.forEach(code => {
        this.codes.get(code)!.forEach(({ webview }) => {
          this.updateWebview(webview, code);
        });
      });
    });
    // Process when source code changes
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.contentChanges.length === 0) { return; }
      const code = event.document;
      const panels = this.codes.get(code);
      if (!panels) { return; }
      const previousCache = this.sourceDoms.get(code);
      const dom = new JSDOM(code.getText(), { includeNodeLocations: true });
      panels.forEach(panel => {
        if (this.editedBy.delete(panel)) {
          this.postCodeRanges(code, panel);
          return;
        }
        if (
          event.reason === undefined
          && event.contentChanges.length === 1
          && previousCache
          && this.tryPatchWebview(panel.webview, code, event.contentChanges[0], previousCache, dom)
        ) {
          return;
        }
        this.updateWebview(panel.webview, code);
      });
      this.sourceDoms.set(code, this.buildSourceDomCache(dom));
    });
    // Process when text selection is changed
    vscode.window.onDidChangeTextEditorSelection(event => {
      const code = event.textEditor.document;
      if (!this.codes.has(code) || (
        event.kind && (
          event.kind !== vscode.TextEditorSelectionChangeKind.Keyboard
          && event.kind !== vscode.TextEditorSelectionChangeKind.Mouse
        )
      )) {
        return;
      }
      const positions = event.selections.filter(
        s => !s.isEmpty
      ).map(
        s => ({ start: code.offsetAt(s.start), end: code.offsetAt(s.end) })
      );
      if (positions.length === 0) { return; }
      this.codes.get(code)?.forEach(panel => {
        panel.webview.postMessage({
          type: 'select',
          data: positions
        });
      });
    });
  }

  private postCodeRanges(code: vscode.TextDocument, panel: vscode.WebviewPanel) {
    const dom = new JSDOM(code.getText(), { includeNodeLocations: true });
    panel.webview.postMessage({
      type: 'codeRanges',
      data: Array.from(dom.window.document.querySelectorAll('body *, body')).map(element => {
        const range = dom.nodeLocation(element);
        return {
          element: this.shortName(element),
          start: range?.startOffset, end: range?.endOffset
        };
      })
    });
  }

  public async resolveCustomTextEditor(
    code: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _: vscode.CancellationToken
  ): Promise<void> {
    // Manage webview panels
    if (this.codes.has(code)) {
      this.codes.get(code)?.add(panel);
    } else {
      const panels = new Set<vscode.WebviewPanel>();
      panels.add(panel);
      this.codes.set(code, panels);
    }
    panel.onDidChangeViewState(event => {
      if (event.webviewPanel.visible) { this.activeCode = code; }
    });
    // Initialize WebView
    panel.webview.options = { enableScripts: true };
    panel.onDidDispose(() => {
      this.codes.get(code)?.delete(panel);
      this.editedBy.delete(panel);
      if (this.codes.get(code)?.size === 0) {
        this.codes.delete(code);
        this.sourceDoms.delete(code);
      }
    });
    // Message from WebView
    panel.webview.onDidReceiveMessage(event => {
      switch (event.type) {
        case 'state':
          this.codes.get(code)?.forEach(p => {
            if (p === panel) { return; }
            p.webview.postMessage(event);
          });
          break;
        case 'refresh':
          this.updateWebview(panel.webview, code);
          break;
        case 'select':
          this.selectElements(code, event);
          break;
        case 'edit':
          if (this.editElements(code, event)) {
            this.editedBy.add(panel);
          }
          break;
        case 'delete':
          this.deleteElements(code, this.getNiceRanges(code, event.data));
          break;
        case 'copy':
          this.copyElements(code, this.getNiceRanges(code, event.data));
          break;
        case 'cut':
          const niceRanges = this.getNiceRanges(code, event.data);
          this.copyElements(code, niceRanges);
          this.deleteElements(code, niceRanges);
          break;
        case 'paste':
          this.pasteToElement(code, event);
          break;
      }
    });
    // Update webview
    this.updateWebview(panel.webview, code);
    this.activeCode = code;
  }

  // Select code range of selected element
  private selectElements(code: vscode.TextDocument, event: any) {
    const selections = this.getNiceRanges(code, event.data).map(range => {
      return new vscode.Selection(range.start, range.end);
    });
    vscode.window.visibleTextEditors.forEach(editor => {
      if (editor.document !== code) { return; }
      editor.selections = selections;
      if (selections.length > 0) {
        editor.revealRange(selections.at(-1)!, vscode.TextEditorRevealType.InCenter);
      }
    });
  }

  // Reflect edits on WebView to source code
  private editElements(code: vscode.TextDocument, event: any) {
    const edit = new vscode.WorkspaceEdit();
    let shouldEdit = false;
    event.data.forEach((codeEdit: any) => {
      const range = new vscode.Range(
        code.positionAt(codeEdit.codeRange.start),
        code.positionAt(codeEdit.codeRange.end)
      );
      const text = code.getText(range);
      const fragment = JSDOM.fragment(text).firstElementChild;
      if (fragment === null) {
        throw Error(
          'Failed to create virtual DOM from code fragment of '
          + `${code.fileName}(${codeEdit.codeRange.start}, ${codeEdit.codeRange.end})\n`
          + text
        );
      }
      codeEdit.operations.forEach((operation: any) => {
        shouldEdit = true;
        if (operation.style === null) {
          fragment.removeAttribute('style');
        } else {
          fragment.setAttribute('style', operation.style);
        }
      });
      edit.replace(code.uri, range, fragment.outerHTML, {
        needsConfirmation: false, label: 'Edit on WebView'
      });
    });
    if (shouldEdit) {
      vscode.workspace.applyEdit(edit);
    }
    return shouldEdit;
  }

  private deleteElements(code: vscode.TextDocument, ranges: vscode.Range[]) {
    const edit = new vscode.WorkspaceEdit();
    ranges.forEach((range: vscode.Range) => edit.delete(code.uri, range));
    vscode.workspace.applyEdit(edit);
  }

  // Copy process on WebView
  private copyElements(code: vscode.TextDocument, ranges: vscode.Range[]) {
    const textToCopy = ranges.map((range: vscode.Range) => {
      const indent = code.lineAt(range.start.line).text.match(/^\s+/);
      const text = code.getText(range);
      return indent === null ? text : text.replace(new RegExp(`^${indent}`, 'gm'), '');
    }).join('\n');
    vscode.env.clipboard.writeText(textToCopy);
  }

  // Paste process on WebView
  private async pasteToElement(code: vscode.TextDocument, event: any) {
    const clipboard = (await vscode.env.clipboard.readText()).trim() + '\n';
    if (clipboard.length === 0) { return; }
    const { start, end } = event.data.codeRange;
    const destPos = code.positionAt(
      start + code.getText(
        new vscode.Range(code.positionAt(start), code.positionAt(end))
      ).lastIndexOf('</')
    );
    const text = event.data.isHtml ? clipboard : he.escape(clipboard);
    {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(code.uri, destPos, text, { needsConfirmation: false, label: 'Paste on WebView' });
      await vscode.workspace.applyEdit(edit);
    }
    {
      const formatEdits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        'vscode.executeFormatRangeProvider',
        code.uri,
        new vscode.Range(code.positionAt(start), code.positionAt(end + text.length)),
        {
          tabSize: this.editorOptions.indentSize,
          insertSpaces: this.editorOptions.insertSpaces
        }
      );
      const edit = new vscode.WorkspaceEdit();
      for (const f of formatEdits) {
        edit.replace(code.uri, f.range, f.newText, { needsConfirmation: false, label: 'Paste on WebView' });
      }
      await vscode.workspace.applyEdit(edit);
    }
    vscode.window.visibleTextEditors.forEach(editor => {
      if (editor.document !== code) { return; }
      editor.revealRange(
        new vscode.Range(destPos, destPos), vscode.TextEditorRevealType.InCenter
      );
    });
  }

  // Reflect content of source code to WebView
  private updateWebview(webview: vscode.Webview, code: vscode.TextDocument) {
    const config = vscode.workspace.getConfiguration('webVisualEditor');
    const dom = new JSDOM(code.getText(), { includeNodeLocations: true });
    const document = dom.window.document;
    if (!config.get<boolean>('allowScript')) {
      // Disable scripts in code
      document.querySelectorAll('script').forEach(el => { el.remove(); });
      document.querySelectorAll('body *, body').forEach(el => {
        // Remove event attributes
        el.removeAttribute('disabled');
        const nameToRemove = [];
        for (const attr of el.attributes) {
          if (attr.name.startsWith('on')) {
            nameToRemove.push(attr.name);
          }
        }
        nameToRemove.forEach(name => el.removeAttribute(name));
      });
    }
    document.querySelectorAll('body *, body').forEach(el => {
      this.applyCodeLocation(el, dom.nodeLocation(el));
    });
    // Disable links and file selection inputs
    document.body.querySelectorAll('a[href]').forEach(
      el => el.setAttribute('onclick', 'event.preventDefault(), event.stopPropagation()')
    );
    document.body.querySelectorAll('input[type=file]').forEach(el => el.setAttribute('disabled', ''));
    // - Replace URIs (mainly for CSS files) to be handled in sandbox of WebView
    // - Save resource path to update WebView when it changes
    const curdir = path.dirname(code.uri.fsPath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(code.uri);
    const workspaceRoot = workspaceFolder?.uri.fsPath ?? curdir;
    const root = this.resolveRoot(config, workspaceRoot);
    (['href', 'src'] as const).forEach(attr => {
      document.querySelectorAll(`[${attr}]`).forEach(el => {
        this.rewriteResourceUri(el, attr, webview, code, curdir, root);
      });
    });
    // Add code id
    const embeddedScript = document.createElement('script');
    embeddedScript.textContent = `const wve = ${JSON.stringify({
      codeId: code.uri.toString(), config
    })}`;
    document.head.appendChild(embeddedScript);
    // Default style
    const defaultStyle = document.createElement('style');
    defaultStyle.textContent = 'html, body { background-color: white; }';
    document.head.prepend(defaultStyle);
    // Incorporate CSS files into layer and lower their priority
    const style = document.createElement('style');
    document.querySelectorAll('link[href][rel=stylesheet]').forEach(el => {
      style.append(`@import url('${el.getAttribute('href')}') layer(user-style);\n`);
      el.remove();
    });
    style.id = 'wve-user-css-imports';
    document.head.appendChild(style);
    if (config.get<boolean>('allowScript')) {
      const globalScripts = config.get<string[]>('globalScripts') ?? [];
      for (const src of globalScripts) {
        const el = document.createElement('script');
        if (this.isLocalResource(src)) {
          const resolvedPath = path.join(
            src.startsWith('/') ? root : curdir,
            src.replace(/^\//, '')
          );
          this.addToResources(code, resolvedPath);
          el.setAttribute('src', webview.asWebviewUri(vscode.Uri.file(resolvedPath)).toString());
        } else {
          el.setAttribute('src', src);
        }
        document.head.appendChild(el);
      }
    }
    // Incorporate resources on WebView side
    const link = document.createElement('link');
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('href',
      webview.asWebviewUri(
        vscode.Uri.file(path.join(this.context.extensionPath, 'webview', 'style.css'))
      ).toString()
    );
    document.head.appendChild(link);
    const script = document.createElement('script');
    script.setAttribute('src',
      webview.asWebviewUri(
        vscode.Uri.file(path.join(this.context.extensionPath, 'webview', 'webview.js'))
      ).toString()
    );
    document.head.appendChild(script);
    // Add timestamp to ensure update WebView
    // NOTE WebView has HTML cache, and if the same string is set consecutively,
    // it will not reflect it even if actual HTML on the WebView has been updated.
    const timestamp = document.createElement('meta');
    timestamp.setAttribute('name', 'wve-timestamp');
    timestamp.setAttribute('value', (new Date()).toISOString());
    document.head.appendChild(timestamp);
    webview.html = dom.serialize();
    this.sourceDoms.set(code, this.buildSourceDomCache(dom));
  }

  // Add source code location information to an element
  private applyCodeLocation(el: Element, location: Token.Location | null | undefined) {
    if (!location) {
      // NOTE `location` can be null if the element is implicitly inserted
      // according to the HTML specification (e.g., `table > tbody`), or if `el`
      // is a clone whose location was looked up from its original node instead.
      return;
    }
    el.setAttribute('data-wve-code-start', location.startOffset.toString());
    el.setAttribute('data-wve-code-end', location.endOffset.toString());
  }

  // Replace a local resource URI to be handled in sandbox of WebView
  private rewriteResourceUri(
    el: Element, attr: 'href' | 'src', webview: vscode.Webview,
    code: vscode.TextDocument, curdir: string, root: string
  ) {
    if (el.tagName === 'A') { return; }
    const uri = el.getAttribute(attr);
    if (uri === null || !this.isLocalResource(uri)) { return; }
    const resolvedPath = path.join(uri.startsWith('/') ? root : curdir, uri.replace(/^\//, ''));
    this.addToResources(code, resolvedPath);
    el.setAttribute(attr, webview.asWebviewUri(vscode.Uri.file(resolvedPath)).toString());
  }

  private buildSourceDomCache(dom: JSDOM): SourceDomCache {
    const byStartOffset = new Map<number, Element>();
    dom.window.document.querySelectorAll('body *, body').forEach(el => {
      const location = dom.nodeLocation(el);
      if (location) { byStartOffset.set(location.startOffset, el); }
    });
    return { dom, byStartOffset };
  }

  private findElementBySourceStart(cache: SourceDomCache, startOffset: number, tagName: string): Element | undefined {
    const el = cache.byStartOffset.get(startOffset);
    return el?.tagName === tagName ? el : undefined;
  }

  private hasShiftedLocation(
    oldLocation: Token.Location | null | undefined,
    newLocation: Token.Location | null | undefined,
    delta: number
  ) {
    return !!oldLocation
      && !!newLocation
      && oldLocation.startOffset === newLocation.startOffset
      && oldLocation.endOffset + delta === newLocation.endOffset;
  }

  private sameChildNodeIndex(oldNode: ChildNode, newNode: ChildNode) {
    if (!oldNode.parentNode || !newNode.parentNode) { return false; }
    return Array.from(oldNode.parentNode.childNodes).indexOf(oldNode)
      === Array.from(newNode.parentNode.childNodes).indexOf(newNode);
  }

  // Whether `oldNode` and `newNode` refer to the same logical node: same type/tag, and
  // its location is either entirely before the edit (unchanged) or entirely after it
  // (shifted by `delta`). Accepts null for sibling checks where a node may not exist.
  private isStableNode(
    oldDom: JSDOM,
    newDom: JSDOM,
    oldNode: ChildNode | null,
    newNode: ChildNode | null,
    oldEditStart: number,
    oldEditEnd: number,
    delta: number
  ) {
    if (!oldNode || !newNode) { return oldNode === newNode; }
    if (oldNode.nodeType !== newNode.nodeType) { return false; }
    if (
      oldNode.nodeType === oldNode.ELEMENT_NODE
      && (oldNode as Element).tagName !== (newNode as Element).tagName
    ) {
      return false;
    }
    const oldLocation = oldDom.nodeLocation(oldNode);
    const newLocation = newDom.nodeLocation(newNode);
    if (!oldLocation || !newLocation) { return false; }
    if (oldLocation.endOffset <= oldEditStart) {
      return oldLocation.startOffset === newLocation.startOffset
        && oldLocation.endOffset === newLocation.endOffset;
    }
    if (oldEditEnd <= oldLocation.startOffset) {
      return oldLocation.startOffset + delta === newLocation.startOffset
        && oldLocation.endOffset + delta === newLocation.endOffset;
    }
    return false;
  }

  private isSameParentPosition(
    oldDom: JSDOM, newDom: JSDOM, oldTarget: Element, newTarget: Element, delta: number
  ) {
    const oldParent = oldTarget.parentElement;
    const newParent = newTarget.parentElement;
    if (!oldParent || !newParent || oldParent.tagName !== newParent.tagName) { return false; }
    if (!this.hasShiftedLocation(oldDom.nodeLocation(oldParent), newDom.nodeLocation(newParent), delta)) {
      return false;
    }
    return this.sameChildNodeIndex(oldTarget, newTarget);
  }

  private isTextPatchSafe(
    oldDom: JSDOM,
    newDom: JSDOM,
    oldTarget: Element,
    newTarget: Element,
    change: vscode.TextDocumentContentChangeEvent,
    delta: number
  ) {
    if (!this.hasShiftedLocation(oldDom.nodeLocation(oldTarget), newDom.nodeLocation(newTarget), delta)) {
      return false;
    }
    if (!this.isSameParentPosition(oldDom, newDom, oldTarget, newTarget, delta)) {
      return false;
    }
    const oldEditEnd = change.rangeOffset + change.rangeLength;
    const newEditEnd = change.rangeOffset + change.text.length;
    const oldTargetLocation = oldDom.nodeLocation(oldTarget) as Token.ElementLocation | null | undefined;
    const newTargetLocation = newDom.nodeLocation(newTarget) as Token.ElementLocation | null | undefined;
    if (
      !oldTargetLocation?.startTag
      || !oldTargetLocation.endTag
      || !newTargetLocation?.startTag
      || !newTargetLocation.endTag
      || change.rangeOffset < oldTargetLocation.startTag.endOffset
      || oldTargetLocation.endTag.startOffset < oldEditEnd
      || change.rangeOffset < newTargetLocation.startTag.endOffset
      || newTargetLocation.endTag.startOffset < newEditEnd
    ) {
      return false;
    }
    const oldNonTextNodes = Array.from(oldTarget.childNodes).filter(
      node => node.nodeType !== node.TEXT_NODE
    );
    const newNonTextNodes = Array.from(newTarget.childNodes).filter(
      node => node.nodeType !== node.TEXT_NODE
    );
    return oldNonTextNodes.length === newNonTextNodes.length
      && oldNonTextNodes.every((oldNode, index) => this.isStableNode(
        oldDom, newDom, oldNode, newNonTextNodes[index], change.rangeOffset, oldEditEnd, delta
      ));
  }

  private isElementPatchSafe(
    oldDom: JSDOM,
    newDom: JSDOM,
    oldTarget: Element,
    newTarget: Element,
    change: vscode.TextDocumentContentChangeEvent,
    delta: number
  ) {
    if (!this.hasShiftedLocation(oldDom.nodeLocation(oldTarget), newDom.nodeLocation(newTarget), delta)) {
      return false;
    }
    if (!this.isSameParentPosition(oldDom, newDom, oldTarget, newTarget, delta)) {
      return false;
    }
    const oldEditEnd = change.rangeOffset + change.rangeLength;
    return this.isStableNode(
      oldDom, newDom, oldTarget.previousSibling, newTarget.previousSibling, change.rangeOffset, oldEditEnd, delta
    ) && this.isStableNode(
      oldDom, newDom, oldTarget.nextSibling, newTarget.nextSibling, change.rangeOffset, oldEditEnd, delta
    );
  }

  // Try to patch WebView by replacing only the element affected by a single content change,
  // instead of reloading the whole WebView. Returns false when a full reload is required.
  private tryPatchWebview(
    webview: vscode.Webview, code: vscode.TextDocument, change: vscode.TextDocumentContentChangeEvent,
    previousCache: SourceDomCache, dom: JSDOM
  ): boolean {
    const config = vscode.workspace.getConfiguration('webVisualEditor');
    const document = dom.window.document;
    const editStart = change.rangeOffset;
    const editEnd = editStart + change.text.length;
    const offsetDelta = change.text.length - change.rangeLength;
    const bodyLocation = dom.nodeLocation(document.body);
    if (!bodyLocation || editStart < bodyLocation.startOffset || bodyLocation.endOffset < editEnd) {
      return false;
    }
    // Find the smallest element that fully contains the edited range
    let target: Element = document.body;
    for (;;) {
      const child = Array.from(target.children).find(c => {
        const loc = dom.nodeLocation(c);
        if (!loc) { return false; }
        return loc.startOffset <= editStart && editEnd <= loc.endOffset;
      });
      if (!child) { break; }
      target = child;
    }
    if (target === document.body) { return false; }
    if (target.tagName === 'SCRIPT' || target.querySelector('script')) { return false; }
    const targetLocation = dom.nodeLocation(target) as Token.ElementLocation;
    const oldDom = previousCache.dom;
    const oldTarget = this.findElementBySourceStart(previousCache, targetLocation.startOffset, target.tagName);
    if (!oldTarget) { return false; }
    // If the edit is fully contained in a single text node, patch just that text node
    // instead of recreating the element. This avoids losing WebView-only transient state
    // that isn't represented in the source, such as an open <details>.
    if (targetLocation.startTag && targetLocation.endTag) {
      const contentStart = targetLocation.startTag.endOffset;
      const contentEnd = targetLocation.endTag.startOffset;
      if (editStart >= contentStart && editEnd <= contentEnd) {
        const childIndex = Array.from(target.childNodes).findIndex(node => {
          if (node.nodeType !== target.TEXT_NODE) { return false; }
          const loc = dom.nodeLocation(node);
          if (!loc) { return false; }
          return loc.startOffset <= editStart && editEnd <= loc.endOffset;
        });
        if (this.isTextPatchSafe(oldDom, dom, oldTarget, target, change, offsetDelta)) {
          const textChildren = Array.from(target.childNodes).flatMap((node, index) => {
            return node.nodeType === node.TEXT_NODE
              ? [{ index, text: (node as Text).data }]
              : [];
          });
          webview.postMessage({
            type: 'patch',
            data: {
              mode: 'text',
              targetStart: targetLocation.startOffset,
              childIndex,
              text: childIndex === -1 ? '' : (target.childNodes[childIndex] as Text).data,
              textChildren,
              editStart,
              offsetDelta
            }
          });
          return true;
        }
      }
    }
    if (!this.isElementPatchSafe(oldDom, dom, oldTarget, target, change, offsetDelta)) {
      return false;
    }
    const curdir = path.dirname(code.uri.fsPath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(code.uri);
    const workspaceRoot = workspaceFolder?.uri.fsPath ?? curdir;
    const root = this.resolveRoot(config, workspaceRoot);
    const allowScript = !!config.get<boolean>('allowScript');
    // `dom` is shared across all panels of this document and cached for the next edit,
    // so mutate a clone of the target subtree here rather than `target` itself -- href/src
    // rewriting is specific to this panel's WebView origin.
    const originalElements = [target, ...Array.from(target.querySelectorAll('*'))];
    const workingTarget = target.cloneNode(true) as Element;
    const workingElements = [workingTarget, ...Array.from(workingTarget.querySelectorAll('*'))];
    workingElements.forEach((el, index) => {
      if (!allowScript) {
        el.removeAttribute('disabled');
        const nameToRemove: string[] = [];
        for (const attr of el.attributes) {
          if (attr.name.startsWith('on')) { nameToRemove.push(attr.name); }
        }
        nameToRemove.forEach(name => el.removeAttribute(name));
      }
      this.applyCodeLocation(el, dom.nodeLocation(originalElements[index]));
      if (el.tagName === 'A' && el.hasAttribute('href')) {
        el.setAttribute('onclick', 'event.preventDefault(), event.stopPropagation()');
      }
      if (el.tagName === 'INPUT' && el.getAttribute('type') === 'file') {
        el.setAttribute('disabled', '');
      }
      this.rewriteResourceUri(el, 'href', webview, code, curdir, root);
      this.rewriteResourceUri(el, 'src', webview, code, curdir, root);
    });
    webview.postMessage({
      type: 'patch',
      data: {
        mode: 'element',
        targetStart: targetLocation.startOffset,
        html: workingTarget.outerHTML,
        editStart,
        offsetDelta
      }
    });
    return true;
  }

  private getNiceRanges(code: vscode.TextDocument, ranges: any): vscode.Range[] {
    return ranges.map((range: any) => {
      let start = code.positionAt(range.codeRange.start);
      const lineStart = code.lineAt(start.line);
      if (start.character === lineStart.firstNonWhitespaceCharacterIndex) {
        start = lineStart.range.start;
      }
      let end = code.positionAt(range.codeRange.end);
      const lineEnd = code.lineAt(end.line);
      if (end.isEqual(lineEnd.range.end)) {
        end = lineEnd.rangeIncludingLineBreak.end;
      }
      return new vscode.Range(start, end);
    });
  }

  private addToResources(code: vscode.TextDocument, filepath: string) {
    if (this.resources.has(filepath)) {
      this.resources.get(filepath)?.add(code);
    } else {
      this.resources.set(filepath, new Set([code]));
    }
  }

  private resolveRoot(config: vscode.WorkspaceConfiguration, workspaceRoot: string): string {
    const rootPath = config.get<string>('rootPath')?.trim();
    if (!rootPath) { return workspaceRoot; }
    const resolved = path.resolve(workspaceRoot, rootPath);
    // Reject paths outside the workspace
    const relative = path.relative(workspaceRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { return workspaceRoot; }
    return resolved;
  }

  private isLocalResource(path: string) {
    // Treat a path as a local resource if it resolves to the same origin as a dummy
    // base URL. This excludes absolute URLs (`https://...`), protocol-relative URLs
    // (`//cdn.example.com/...`), and special schemes (`mailto:`, `data:`, etc., which
    // resolve to an opaque origin), while including normal relative paths and
    // root-relative paths (e.g., `/scripts/main.js`).
    const base = 'https://wve-local-resource.invalid/';
    return new URL(path, base).origin === new URL(base).origin;
  }

  private shortName(el: Element) {
    return (
      el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
      + Array.from(el.classList).map(c => `.${c}`).join('')
    );
  }
}
