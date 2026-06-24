import type { SiteAdapterProcedureDefinition } from '../../../core/site-adapter-runtime';

export interface GitHubCreateIssueProcedureInput {
  owner: string;
  repo: string;
  title: string;
  body: string;
}

function clean(value: string, fallback: string): string {
  return value.trim() || fallback;
}

export function createGitHubCreateIssueProcedure(
  input: GitHubCreateIssueProcedureInput = {
    owner: 'owner',
    repo: 'repo',
    title: 'Example issue',
    body: 'Created by the Tianshe Site Adapter high-risk Procedure canary.',
  }
): SiteAdapterProcedureDefinition {
  const owner = clean(input.owner, 'owner');
  const repo = clean(input.repo, 'repo');
  const title = clean(input.title, 'Example issue');
  const body = clean(
    input.body,
    'Created by the Tianshe Site Adapter high-risk Procedure canary.'
  );

  return {
    id: 'create-issue',
    adapterId: 'github-profile',
    sideEffectLevel: 'high',
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
        id: 'fill-issue-form',
        action: 'fillForm',
        fields: [
          { selector: '#issue_title', text: title, clear: true },
          { selector: '#issue_body', text: body, clear: true },
        ],
        verify: {
          id: 'issue-title-visible',
          action: 'verifyText',
          selector: '#issue_title',
          text: title,
        },
      },
      {
        id: 'submit-issue',
        action: 'click',
        selector: 'button[type="submit"]',
        verify: {
          id: 'issue-created',
          action: 'verifyText',
          selector: 'body',
          text: title,
        },
      },
    ],
  };
}

export const createIssueProcedure: SiteAdapterProcedureDefinition =
  createGitHubCreateIssueProcedure();
