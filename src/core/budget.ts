/** Daily + monthly spend caps. Refuse or degrade instead of blowing a cap. */

export interface BudgetState {
  dailySpentUsd: number;
  dailyCapUsd: number;
  monthlySpentUsd: number;
  monthlyCapUsd: number;
  perRunCapUsd: number;
}

export class Budget {
  dailySpentUsd: number;
  dailyCapUsd: number;
  monthlySpentUsd: number;
  monthlyCapUsd: number;
  perRunCapUsd: number;

  constructor(init?: Partial<BudgetState>) {
    this.dailySpentUsd = init?.dailySpentUsd ?? 0;
    this.dailyCapUsd = init?.dailyCapUsd ?? 5;
    this.monthlySpentUsd = init?.monthlySpentUsd ?? 0;
    this.monthlyCapUsd = init?.monthlyCapUsd ?? 50;
    this.perRunCapUsd = init?.perRunCapUsd ?? 5;
  }

  snapshot(): BudgetState & { dailyFraction: number; monthlyFraction: number } {
    return {
      dailySpentUsd: this.dailySpentUsd,
      dailyCapUsd: this.dailyCapUsd,
      monthlySpentUsd: this.monthlySpentUsd,
      monthlyCapUsd: this.monthlyCapUsd,
      perRunCapUsd: this.perRunCapUsd,
      dailyFraction: this.dailyFraction(),
      monthlyFraction: this.monthlyFraction(),
    };
  }

  wouldExceedDaily(estCostUsd: number): boolean {
    return this.dailySpentUsd + estCostUsd > this.dailyCapUsd + 1e-12;
  }

  wouldExceedPerRun(estCostUsd: number): boolean {
    return estCostUsd > this.perRunCapUsd + 1e-12;
  }

  record(costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd < 0) return;
    this.dailySpentUsd += costUsd;
    this.monthlySpentUsd += costUsd;
  }

  dailyFraction(): number {
    if (this.dailyCapUsd <= 0) return 1;
    return Math.min(1, this.dailySpentUsd / this.dailyCapUsd);
  }

  monthlyFraction(): number {
    if (this.monthlyCapUsd <= 0) return 1;
    return Math.min(1, this.monthlySpentUsd / this.monthlyCapUsd);
  }
}

export const defaultBudget = new Budget();
