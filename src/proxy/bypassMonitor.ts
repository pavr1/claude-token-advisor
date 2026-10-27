import * as vscode from 'vscode';
import type { PythonRuntime } from '../budget/pythonRuntime';
import { ClaudeProcess, findBypassing, scan } from './processScan';

/** How often this window's `claude` processes are checked. */
const SCAN_INTERVAL_MS = 20_000;

/**
 * Warns, persistently, when a `claude` started in this window goes straight to Anthropic.
 *
 * Injecting the variable only reaches processes started afterwards; a terminal that was
 * already open (or a client started while the proxy was down) keeps running unrouted, and
 * that is invisible until someone notices the ledger is missing turns.
 */
export class BypassMonitor {
  static readonly COMMAND = 'claudeTokenImprover.showUnroutedClaude';

  private readonly item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;
  private address: string | undefined;
  private scanning = false;
  private bypassing: ClaudeProcess[] = [];
  private failureLogged = false;

  constructor(
    private readonly log: (line: string) => void,
    private readonly getPython: () => Promise<PythonRuntime>
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    this.item.command = BypassMonitor.COMMAND;
    this.item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  /** Start checking against this proxy address; `undefined` (proxy stopped) stops and hides the warning. */
  setAddress(address: string | undefined): void {
    this.address = address;
    if (!address || process.platform !== 'win32') {
      this.stop();
      return;
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.check(), SCAN_INTERVAL_MS);
      setTimeout(() => void this.check(), 3_000);
    }
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.bypassing = [];
    this.item.hide();
  }

  async check(): Promise<void> {
    const address = this.address;
    if (!address || this.scanning) {
      return;
    }
    this.scanning = true;
    try {
      const shellPids = (await Promise.all(vscode.window.terminals.map((terminal) => terminal.processId))).filter(
        (pid): pid is number => typeof pid === 'number'
      );
      const processes = await scan(await this.getPython(), [...shellPids, process.pid]);
      const bad = findBypassing(processes, address);
      const changed = bad.map((proc) => proc.pid).join() !== this.bypassing.map((proc) => proc.pid).join();
      this.bypassing = bad;
      if (changed && bad.length) {
        this.log(`UNROUTED claude in this window: pid ${bad.map((proc) => proc.pid).join(', ')} (talks to Anthropic directly)`);
      }
      this.render();
    } catch (error) {
      if (!this.failureLogged) {
        this.failureLogged = true;
        this.log(`unrouted-claude check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      this.scanning = false;
    }
  }

  private render(): void {
    if (!this.bypassing.length) {
      this.item.hide();
      return;
    }
    this.item.text = `$(warning) Claude not using proxy (${this.bypassing.length})`;
    this.item.tooltip =
      'A claude started in this window bypasses the Token Improver proxy, so its turns are not recorded or optimized. ' +
      'Click for how to fix it.';
    this.item.show();
  }

  async explain(): Promise<void> {
    const count = this.bypassing.length;
    if (!count) {
      void vscode.window.showInformationMessage('Every claude running in this window goes through the proxy.');
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      `${count} claude process(es) in this window talk to Anthropic directly (pid ${this.bypassing
        .map((proc) => proc.pid)
        .join(', ')}). They were started before the proxy variable existed, and a running process cannot be changed. ` +
        'Close its terminal (not just the claude session), open a new one and run "claude --continue" to resume the conversation.',
      { modal: true },
      'Close and resume',
      'Close those terminals',
      'Show terminals'
    );
    if (pick === 'Close and resume') {
      await this.closeTerminals(true);
    } else if (pick === 'Close those terminals') {
      await this.closeTerminals(false);
    } else if (pick === 'Show terminals') {
      await vscode.commands.executeCommand('workbench.action.terminal.focus');
    }
  }

  /** Disposes every terminal whose shell hosts a bypassing claude; the next one opened gets the proxy variable. */
  private async closeTerminals(resume: boolean): Promise<void> {
    const roots = new Set(this.bypassing.map((proc) => proc.rootPid));
    const doomed: vscode.Terminal[] = [];
    for (const terminal of vscode.window.terminals) {
      const pid = await terminal.processId;
      if (pid !== undefined && roots.has(pid)) {
        doomed.push(terminal);
      }
    }
    // Read name and cwd before disposing; the replacement is created after, so it gets the proxy variable.
    const replacements = doomed.map((terminal) => {
      const options = terminal.creationOptions as vscode.TerminalOptions;
      return { name: terminal.name, cwd: options.cwd };
    });
    for (const terminal of doomed) {
      terminal.dispose();
    }
    const closed = doomed.length;
    if (resume) {
      // `--continue` resumes the newest conversation of that directory. Two terminals in the same
      // directory would both pick the same one, so only the first of each directory is resumed.
      const seen = new Set<string>();
      for (const { name, cwd } of replacements) {
        const key = cwd ? (typeof cwd === 'string' ? cwd : cwd.fsPath) : '';
        const terminal = vscode.window.createTerminal({ name, cwd });
        terminal.show(true);
        if (!seen.has(key)) {
          seen.add(key);
          terminal.sendText('claude --continue');
        }
      }
    }
    this.log(`closed ${closed} terminal(s) hosting an unrouted claude${resume ? ' and reopened them with --continue' : ''}`);
    this.bypassing = [];
    this.item.hide();
    if (closed && !resume) {
      void vscode.window.showInformationMessage(
        `Closed ${closed} terminal(s). Open a new one and run "claude --continue" to resume.`
      );
    }
    setTimeout(() => void this.check(), 3_000);
  }

  dispose(): void {
    this.stop();
    this.item.dispose();
  }
}
