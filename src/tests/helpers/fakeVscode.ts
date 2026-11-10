/**
 * A recording stand-in for the `vscode` module, so UI code that imports it can run under node:test.
 * Import this file FIRST in a test (before the module under test): it patches module loading as a
 * side effect, and TypeScript keeps import order.
 *
 * Only what the extension actually touches is modelled. Tests read what the code did through
 * `fake.*` (created status bar items, shown messages, executed commands, settings).
 */

import Module from 'node:module';

export class FakeThemeColor {
  constructor(readonly id: string) {}
}

export class FakeMarkdownString {
  isTrusted = false;
  supportThemeIcons = false;
  supportHtml = false;
  constructor(public value = '') {}
  appendMarkdown(text: string): this {
    this.value += text;
    return this;
  }
  appendText(text: string): this {
    this.value += text;
    return this;
  }
}

export interface FakeStatusBarItem {
  text: string;
  tooltip: unknown;
  command?: string;
  color?: unknown;
  backgroundColor?: unknown;
  name?: string;
  visible: boolean;
  disposed: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface FakeTerminal {
  name: string;
  options: unknown;
  creationOptions: unknown;
  processId: Promise<number | undefined>;
  sent: string[];
  shown: boolean;
  sendText(text: string): void;
  show(): void;
  dispose(): void;
}

export const fake = {
  /** Values `workspace.getConfiguration(...).get(key)` returns; anything absent yields the caller's default. */
  settings: {} as Record<string, unknown>,
  statusBarItems: [] as FakeStatusBarItem[],
  terminals: [] as FakeTerminal[],
  infoMessages: [] as string[],
  warningMessages: [] as string[],
  /** What the user "clicks" in a message box: the next showXMessage resolves to this. */
  nextChoice: undefined as string | undefined,
  commands: [] as Array<{ id: string; args: unknown[] }>,
  webviewPanels: [] as Array<{ viewType: string; title: string; webview: { html: string; messages: unknown[]; handler?: (m: unknown) => void }; disposed: boolean; reveals: number; options?: unknown; onDispose?: () => void; dispose(): void }>,
  reset(): void {
    fake.settings = {};
    fake.statusBarItems = [];
    fake.terminals = [];
    fake.infoMessages = [];
    fake.warningMessages = [];
    fake.nextChoice = undefined;
    fake.commands = [];
    fake.webviewPanels = [];
  },
};

function makeItem(): FakeStatusBarItem {
  const item: FakeStatusBarItem = {
    text: '',
    tooltip: undefined,
    visible: false,
    disposed: false,
    show: () => {
      item.visible = true;
    },
    hide: () => {
      item.visible = false;
    },
    dispose: () => {
      item.disposed = true;
    },
  };
  return item;
}

const vscodeStub = {
  ThemeColor: FakeThemeColor,
  MarkdownString: FakeMarkdownString,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, One: 1 },
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, fallback?: T): T | undefined => (key in fake.settings ? (fake.settings[key] as T) : fallback),
    }),
  },
  window: {
    createStatusBarItem: () => {
      const item = makeItem();
      fake.statusBarItems.push(item);
      return item;
    },
    get terminals() {
      return fake.terminals;
    },
    createTerminal: (options: { name?: string }) => {
      const terminal: FakeTerminal = {
        name: options.name ?? '',
        options,
        creationOptions: options,
        processId: Promise.resolve(undefined),
        sent: [],
        shown: false,
        sendText: (text) => {
          terminal.sent.push(text);
        },
        show: () => {
          terminal.shown = true;
        },
        dispose: () => undefined,
      };
      fake.terminals.push(terminal);
      return terminal;
    },
    showInformationMessage: async (message: string) => {
      fake.infoMessages.push(message);
      return fake.nextChoice;
    },
    showWarningMessage: async (message: string) => {
      fake.warningMessages.push(message);
      return fake.nextChoice;
    },
    createWebviewPanel: (viewType: string, title: string, ...rest: unknown[]) => {
      const panel = {
        viewType,
        title,
        webview: {
          html: '',
          messages: [] as unknown[],
          handler: undefined as ((m: unknown) => void) | undefined,
          onDidReceiveMessage: (cb: (m: unknown) => void) => {
            panel.webview.handler = cb;
            return { dispose: () => undefined };
          },
          postMessage: async (m: unknown) => {
            panel.webview.messages.push(m);
            return true;
          },
        },
        disposed: false,
        onDispose: undefined as (() => void) | undefined,
        onDidDispose: (cb: () => void) => {
          panel.onDispose = cb;
          return { dispose: () => undefined };
        },
        reveals: 0,
        options: undefined as unknown,
        reveal: () => {
          panel.reveals += 1;
        },
        // Like VS Code, onDidDispose fires once however many times dispose() is called.
        dispose: () => {
          if (panel.disposed) {
            return;
          }
          panel.disposed = true;
          panel.onDispose?.();
        },
      };
      panel.options = rest;
      fake.webviewPanels.push(panel);
      return panel;
    },
  },
  commands: {
    executeCommand: async (id: string, ...args: unknown[]) => {
      fake.commands.push({ id, args });
    },
  },
};

const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]): unknown {
  return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, ...rest);
};
