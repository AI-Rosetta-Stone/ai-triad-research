import issueTypesRegistry from './issue-types-registry.json' with { type: 'json' };

export type IssueType = 'loss_of_control' | 'misuse' | 'power_concentration' | 'economic' | 'political' | 'social';

export const ISSUE_TYPES: readonly IssueType[] = [
  'loss_of_control',
  'misuse',
  'power_concentration',
  'economic',
  'political',
  'social',
];

export interface IssueTypeLabel {
  label: string;
  definition: string;
}

export type IssueTypeLabelRegistry = Record<IssueType, IssueTypeLabel>;

export const issueTypeLabels: IssueTypeLabelRegistry = issueTypesRegistry.labels;

export function getLabelForIssueType(issueType: IssueType): string {
  return issueTypeLabels[issueType]?.label ?? issueType;
}

export function getDefinitionForIssueType(issueType: IssueType): string {
  return issueTypeLabels[issueType]?.definition ?? '';
}
