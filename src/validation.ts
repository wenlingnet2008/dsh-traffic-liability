/** Expected payload violations, collected without suppressing runtime or storage failures. */
export interface ValidationIssue {
  path: string;
  message: string;
  actual?: string[];
  expected?: string;
  allowedValues?: string[];
  missingValues?: string[];
  relatedPaths?: string[];
}

/** A rejected payload; callers may render its issues without an exception stack. */
export class PayloadValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(issues.slice(0, 12).map((issue) => `${issue.path} ${issue.message}`).join('；'));
    this.name = 'PayloadValidationError';
  }
}

/**
 * Render a bounded rejection for a model to correct before resubmitting.
 * @param stage rejected stage
 * @param error expected payload violation
 * @returns unsaved result with paths and the number of omitted errors or reference suggestions
 */
export function validationFailure(stage: string, error: PayloadValidationError) {
  const errors = error.issues.slice(0, 12).map((issue) => ({
    ...issue,
    ...(issue.actual ? { actual: issue.actual.slice(0, 20), omittedActual: Math.max(0, issue.actual.length - 20) } : {}),
    ...(issue.allowedValues ? { allowedValues: issue.allowedValues.slice(0, 20), omittedAllowedValues: Math.max(0, issue.allowedValues.length - 20) } : {}),
    ...(issue.missingValues ? { missingValues: issue.missingValues.slice(0, 20), omittedMissingValues: Math.max(0, issue.missingValues.length - 20) } : {}),
    ...(issue.relatedPaths ? { relatedPaths: issue.relatedPaths.slice(0, 20), omittedRelatedPaths: Math.max(0, issue.relatedPaths.length - 20) } : {}),
  }));
  return {
    saved: false as const,
    stage,
    code: 'validation_failed' as const,
    errors,
    totalErrors: error.issues.length,
    omittedErrors: error.issues.length - errors.length,
    correction: stage === 'liability'
      ? '本次未保存。集中修正 errors 指定的字段和缺失 ID。若关键事实或因果作用仍未知，保留上游调查要求，将 recommendationType 设为 undetermined、各方 level 设为暂无法判断、primaryScenarioId 设为 null、scenarios/exclusions 设为空数组，说明 limitations；无需反复试探等级或改写上游以取得确定结论。'
      : '本次未保存。保留现有 payload，只修正 errors 中的字段后重试；约束见 traffic_case_read({stage})。不得编造事实或删去必要分析以通过校验。',
  };
}

/** Collect independent checks; guarded callbacks stop before dereferencing invalid references. */
export class ValidationIssues {
  readonly issues: ValidationIssue[] = [];

  /**
   * Record a failed check with reference suggestions.
   * @param condition whether the check passed
   * @param path absolute payload path
   * @param message reason and correction guidance
   * @param details invalid values or allowed reference sources
   */
  check(condition: unknown, path: string, message: string, details: Omit<ValidationIssue, 'path' | 'message'> = {}) {
    if (!condition) this.issues.push({ path, message, ...details });
  }

  /**
   * Collect expected validation failures under a path; propagate unexpected exceptions.
   * @param path prefix for failures thrown by the guarded check
   * @param check validation that may depend on earlier assertions
   */
  capture(path: string, check: () => void) {
    try {
      check();
    } catch (error) {
      if (!(error instanceof PayloadValidationError)) throw error;
      this.issues.push(...error.issues.map((issue) => ({ ...issue, path: path + issue.path.slice(1) })));
    }
  }

  /** Reject the payload if any collected check failed. */
  finish() {
    if (this.issues.length) throw new PayloadValidationError(this.issues);
  }
}
