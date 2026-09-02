/** Hard Stop: cancels in-flight backend calls. */

export class StopController {
  private controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  stop(): void {
    this.controller.abort();
  }

  reset(): void {
    this.controller = new AbortController();
  }
}

export const defaultStop = new StopController();
