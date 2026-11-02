import { ReportInbox } from '../inbox.ts';

export class RecoveryComponent extends ReportInbox {
  protected override onReconnect(): void {
    this.backlog.clear();
  }
}
