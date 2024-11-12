import { nanoid } from 'nanoid';
import {
  CancellationToken,
  Disposable,
  Uri,
  Webview,
  WebviewView,
  WebviewViewProvider,
  WebviewViewResolveContext,
} from 'vscode';
import * as vscode from 'vscode';
import * as path from 'path';
import fsPromise from 'fs/promises';
import { getUri } from './utils/getUri';
import { getNonce } from './utils/getNonce';
import { DiffContentProviderId, DiffParams } from './types';
import { isProductionMode } from './utils/isProductionMode';

class VscodeReactView implements WebviewViewProvider {
  public static readonly viewType = 'aider-composer.SidebarProvider';
  private disposables: Disposable[] = [];

  private view?: WebviewView;

  setupPromise: Promise<void>;
  private setupResolve: () => void = () => {};
  private isReady = false;

  private pendingMessages: any[] = [];

  private serverUrl: string = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private outputChannel: vscode.LogOutputChannel,
  ) {
    this.setupPromise = new Promise((resolve) => {
      this.setupResolve = () => {
        this.isReady = true;
        for (const message of this.pendingMessages) {
          this.view?.webview.postMessage(message);
        }
        this.pendingMessages = [];
        resolve();

        this.setupResolve = () => {};
      };
    });
  }

  public resolveWebviewView(
    webviewView: WebviewView,
    _context: WebviewViewResolveContext,
    _token: CancellationToken,
  ) {
    this.view = webviewView;

    this.view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    this.view.webview.html = this.getHtmlForWebview(this.view.webview);
    this.setWebviewMessageListener(this.view.webview);
  }

  /**
   * Cleans up and disposes of webview resources when the webview panel is closed.
   */
  public dispose() {
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private getHtmlForWebview(webview: Webview) {
    const file = 'src/main.tsx';
    const localPort = '5173';
    const localServerUrl = `localhost:${localPort}`;

    // The CSS file from the React build output
    const stylesUri = getUri(webview, this.context.extensionUri, [
      'dist-ui',
      'assets',
      'index.css',
    ]);

    let scriptUri;
    const isProd = isProductionMode(this.context);
    if (isProd) {
      scriptUri = getUri(webview, this.context.extensionUri, [
        'dist-ui',
        'assets',
        'index.js',
      ]);
    } else {
      scriptUri = `http://${localServerUrl}/${file}`;
    }

    const nonce = getNonce();

    const reactRefresh = /*html*/ `
        <script type="module">
          import RefreshRuntime from "http://localhost:5173/@react-refresh"
          RefreshRuntime.injectIntoGlobalHook(window)
          window.$RefreshReg$ = () => {}
          window.$RefreshSig$ = () => (type) => type
          window.__vite_plugin_react_preamble_installed__ = true
        </script>`;

    // const reactRefreshHash =
    //   "sha256-YmMpkm5ow6h+lfI3ZRp0uys+EUCt6FOyLkJERkfVnTY=";

    const csp = [
      `default-src 'none';`,
      `script-src 'unsafe-eval' https://* ${
        isProd
          ? `'nonce-${nonce}'`
          : // 这里的hash是计算的什么代码的hash？
            // : `http://${localServerUrl} http://0.0.0.0:${localPort} '${reactRefreshHash}'`
            `http://${localServerUrl} http://0.0.0.0:${localPort} 'unsafe-inline'`
      }`,
      `style-src ${webview.cspSource} 'self' 'unsafe-inline' https://*`,
      `font-src ${webview.cspSource}`,
      `connect-src https://* ${
        isProd
          ? `http://127.0.0.1:*`
          : `ws://${localServerUrl} http://${localServerUrl} http://localhost:*  http://127.0.0.1:*`
      }`,
    ];

    return /*html*/ `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta http-equiv="Content-Security-Policy" content="${csp.join(
            '; ',
          )}">
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <link rel="stylesheet" type="text/css" href="${stylesUri}">
          <title>VSCode React Starter</title>
        </head>
        <body>
          <div id="root"></div>
          ${isProd ? '' : reactRefresh}
          <script type="module" src="${scriptUri}"></script>
        </body>
      </html>`;
  }

  postMessageToWebview(data: any) {
    if (!this.isReady) {
      this.pendingMessages.push(data);
      return;
    }
    this.view?.webview.postMessage(data);
  }

  /**
   * Sets up an event listener to listen for messages passed from the webview context and
   * executes code based on the message that is recieved.
   *
   * @param webview A reference to the extension webview
   * @param context A reference to the extension context
   */
  private setWebviewMessageListener(webview: Webview) {
    webview.onDidReceiveMessage(
      async (message: any) => {
        const command = message.command;
        const data = message.data;

        let promise: Promise<any> | any;
        switch (command) {
          case 'webview-ready':
            promise = this.webviewReady();
            break;
          case 'search-file':
            promise = this.findFile(data);
            break;
          case 'write-file':
            promise = this.writeFile(data);
            break;
          case 'log-to-output':
            promise = this.logToOutput(data);
            break;
          case 'get-opened-files':
            promise = this.getOpenedFiles();
            break;
          case 'show-error-message':
            promise = this.showErrorMessage(data);
            break;
          case 'show-info-message':
            promise = this.showInfoMessage(data);
            break;
          case 'set-global-state':
            promise = this.setGlobalState(data);
            break;
          case 'get-global-state':
            promise = this.getGlobalState(data);
            break;
          case 'set-workspace-state':
            promise = this.setWorkspaceState(data);
            break;
          case 'get-workspace-state':
            promise = this.getWorkspaceState(data);
            break;
          case 'delete-workspace-state':
            promise = this.deleteWorkspaceState(data);
            break;
          // Add more switch case statements here as more webview message commands
          // are created within the webview context (i.e. inside media/main.js)
        }
        const result = await promise;
        this.postMessageToWebview({
          id: message.id,
          command: 'result',
          data: result,
        });
      },
      undefined,
      this.disposables,
    );
  }

  private async webviewReady() {
    this.setupResolve();
    if (this.isReady && this.serverUrl) {
      this.postMessageToWebview({
        command: 'server-started',
        data: this.serverUrl,
      });
    }
  }

  private async setGlobalState(data: { key: string; value: any }) {
    return this.context.globalState.update(data.key, data.value);
  }

  private async setWorkspaceState(data: { key: string; value: any }) {
    return this.context.workspaceState.update(data.key, data.value);
  }

  private async deleteWorkspaceState(data: { key: string }) {
    return this.context.workspaceState.update(data.key, undefined);
  }

  private async getGlobalState(data: { key: string }) {
    return this.context.globalState.get(data.key);
  }

  private async getWorkspaceState(data: { key: string }) {
    return this.context.workspaceState.get(data.key);
  }

  private async showErrorMessage(data: { message: string }) {
    vscode.window.showErrorMessage(data.message);
  }

  private async showInfoMessage(data: { message: string }) {
    vscode.window.showInformationMessage(data.message);
  }

  private async logToOutput(data: {
    type: 'info' | 'warn' | 'error';
    message: string;
  }) {
    this.outputChannel[data.type](`From Webview: ${data.message}`);
  }

  private async getOpenedFiles() {
    const basePathSet = new Set<string>();
    const allTabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);

    return allTabs
      .filter((tab) => {
        const uri = (tab.input as any)?.uri;
        return uri?.scheme === 'file';
      })
      .map((tab) => {
        const uri = (tab.input as any).uri as vscode.Uri;
        let basePath;
        for (const path of basePathSet) {
          if (uri.fsPath.startsWith(path)) {
            basePath = path;
            break;
          }
        }

        if (!basePath) {
          basePath = this.getFileBasePath(uri);
          basePathSet.add(basePath);
        }

        return {
          name: path.basename(uri.fsPath),
          basePath: basePath,
          path: path.relative(basePath, uri.fsPath),
          fsPath: uri.fsPath,
        };
      });
  }

  private async writeFile(data: { path: string; content: string }) {
    this.outputChannel.info(`command write file: ${data.path}`);

    let isNewFile = false;
    try {
      await fsPromise.access(data.path, fsPromise.constants.R_OK);
    } catch (error) {
      isNewFile = true;
    }

    try {
      const originalUri = isNewFile
        ? vscode.Uri.parse(`${DiffContentProviderId}:${data.path}`).with({
            query: Buffer.from('').toString('base64'),
          })
        : vscode.Uri.file(data.path);
      const modifiedUri = vscode.Uri.parse(
        `${DiffContentProviderId}:${data.path}`,
      ).with({
        query: Buffer.from(data.content).toString('base64'),
      });

      const name = path.basename(data.path);
      // 打开 diff 编辑器
      await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        modifiedUri,
        `${name} ${isNewFile ? 'Created' : 'Modified'}`,
      );
    } catch (error) {
      this.outputChannel.error(`Error opening diff: ${error}`);
    }
  }

  private getFileBasePath(fileUri: vscode.Uri) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
    return workspaceFolder?.uri.fsPath ?? '';
  }

  private findFile(data: { query: string; limit?: number }) {
    const { query, limit = 20 } = data;

    const basePathSet = new Set<string>();

    const ignore = ['**/{node_modules,__pycache__}'];
    return vscode.workspace
      .findFiles(`**/*${query}*`, ignore.join(','), limit)
      .then((files) => {
        return files.map((item) => {
          let basePath;
          for (const path in basePathSet) {
            if (item.fsPath.startsWith(path)) {
              basePath = path;
              break;
            }
          }
          if (!basePath) {
            basePath = this.getFileBasePath(item);
            basePathSet.add(basePath);
          }

          const relativePath = basePath
            ? path.relative(basePath, item.fsPath)
            : item.fsPath;
          return {
            name: path.basename(item.fsPath),
            basePath,
            path: relativePath,
            fsPath: item.fsPath,
          };
        });
      });
  }

  setViewType(viewType: 'chat' | 'setting') {
    this.postMessageToWebview({
      id: nanoid(),
      command: 'set-view-type',
      data: viewType,
    });
  }

  newChat() {
    this.postMessageToWebview({
      id: nanoid(),
      command: 'new-chat',
    });
  }

  currentEditorChanged(editor: vscode.TextEditor) {
    if (editor.document.uri.scheme !== 'file') {
      return;
    }

    const uri = editor.document.uri;
    const basePath = this.getFileBasePath(uri);
    this.postMessageToWebview({
      id: nanoid(),
      command: 'current-editor-changed',
      data: {
        name: path.basename(uri.fsPath),
        basePath,
        path: path.relative(basePath, uri.fsPath),
        fsPath: uri.fsPath,
      },
    });
  }

  serverStarted(url: string) {
    this.outputChannel.info(`server started: ${url}`);
    this.serverUrl = url;
    this.postMessageToWebview({
      id: nanoid(),
      command: 'server-started',
      data: url,
    });
  }
}

export default VscodeReactView;