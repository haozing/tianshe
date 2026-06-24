import type { SiteAdapterProcedureDefinition } from '../../../core/site-adapter-runtime';

export interface GitHubPrepareIssueDraftProcedureInput {
  owner: string;
  repo: string;
  title: string;
  body: string;
}

function clean(value: string, fallback: string): string {
  return value.trim() || fallback;
}

export function createGitHubPrepareIssueDraftProcedure(
  input: GitHubPrepareIssueDraftProcedureInput = {
    owner: 'owner',
    repo: 'repo',
    title: 'Example issue draft',
    body: 'Prepared by the Tianshe Site Adapter low-risk Procedure canary.',
  }
): SiteAdapterProcedureDefinition {
  const owner = clean(input.owner, 'owner');
  const repo = clean(input.repo, 'repo');
  const title = clean(input.title, 'Example issue draft');
  const body = clean(
    input.body,
    'Prepared by the Tianshe Site Adapter low-risk Procedure canary.'
  );

  return {
    id: 'prepare-issue-draft',
    adapterId: 'github-profile',
    sideEffectLevel: 'low',
    steps: [
      {
        id: 'open-new-issue',
        action: 'navigate',
        url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/new`,
        waitUntil: 'domcontentloaded',
        verify: {
          id: 'new-issue-visible',
          action: 'verifyText',
          selector: 'body',
          text: 'New issue',
        },
      },
      {
        id: 'fill-issue-draft',
        action: 'fillForm',
        fields: [
          { selector: '#issue_title', text: title, clear: true },
          { selector: '#issue_body', text: body, clear: true },
        ],
        verify: {
          id: 'issue-title-drafted',
          action: 'verifyText',
          selector: '#issue_title',
          text: title,
        },
      },
      {
        id: 'verify-issue-body-drafted',
        action: 'verifyText',
        selector: '#issue_body',
        text: body,
      },
    ],
  };
}

export const prepareIssueDraftProcedure: SiteAdapterProcedureDefinition =
  createGitHubPrepareIssueDraftProcedure();
