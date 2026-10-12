import { app } from '@azure/functions';
import { DefaultAzureCredential } from '@azure/identity';
import { ContainerInstanceManagementClient } from '@azure/arm-containerinstance';
import { createHmac, timingSafeEqual } from 'node:crypto';

const SUBSCRIPTION_ID = process.env.AZURE_SUBSCRIPTION_ID;
const RESOURCE_GROUP = process.env.RUNNER_RESOURCE_GROUP || 'ai-triad';
const LOCATION = process.env.RUNNER_LOCATION || 'eastus';
const RUNNER_IMAGE = process.env.RUNNER_IMAGE || 'myoung34/github-runner:latest';
const RUNNER_CPU = parseFloat(process.env.RUNNER_CPU || '2');
const RUNNER_MEMORY = parseFloat(process.env.RUNNER_MEMORY || '4');
const RUNNER_LABELS = process.env.RUNNER_LABELS || 'self-hosted,aci';
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'AI-Rosetta-Stone';
const GITHUB_REPO = process.env.GITHUB_REPO || 'ai-triad-research';
const WEBHOOK_SECRET = process.env.GITHUB_RUNNER_WEBHOOK_SECRET;
const GITHUB_PAT = process.env.GITHUB_RUNNER_PAT;

function verifySignature(payload, signature) {
  if (!WEBHOOK_SECRET || !signature) return false;
  const expected = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function containerName(runId) {
  return `gha-runner-${runId}`;
}

async function createRunner(runId, context) {
  if (!SUBSCRIPTION_ID || !GITHUB_PAT) {
    context.error('Missing AZURE_SUBSCRIPTION_ID or GITHUB_RUNNER_PAT');
    return;
  }

  const name = containerName(runId);
  const credential = new DefaultAzureCredential();
  const client = new ContainerInstanceManagementClient(credential, SUBSCRIPTION_ID);

  const tokenRes = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runners/registration-token`,
    {
      method: 'POST',
      headers: {
        Authorization: `token ${GITHUB_PAT}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );
  if (!tokenRes.ok) {
    context.error(`Failed to get registration token: ${tokenRes.status} ${await tokenRes.text()}`);
    return;
  }
  const { token } = await tokenRes.json();

  context.log(`Creating ACI runner: ${name}`);

  await client.containerGroups.beginCreateOrUpdateAndWait(RESOURCE_GROUP, name, {
    location: LOCATION,
    osType: 'Linux',
    restartPolicy: 'Never',
    containers: [
      {
        name: 'runner',
        image: RUNNER_IMAGE,
        resources: { requests: { cpu: RUNNER_CPU, memoryInGB: RUNNER_MEMORY } },
        environmentVariables: [
          { name: 'REPO_URL', value: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}` },
          { name: 'ACCESS_TOKEN', secureValue: token },
          { name: 'RUNNER_NAME', value: name },
          { name: 'RUNNER_SCOPE', value: 'repo' },
          { name: 'LABELS', value: RUNNER_LABELS },
          { name: 'EPHEMERAL', value: '1' },
          { name: 'DISABLE_AUTO_UPDATE', value: '1' },
          { name: 'DOCKER_ENABLED', value: 'true' },
          { name: 'DOCKERD_IN_RUNNER', value: 'true' },
        ],
      },
    ],
    tags: {
      purpose: 'github-actions-runner',
      'github-run-id': String(runId),
      'managed-by': 'runner-webhook-function',
    },
  });

  context.log(`Runner ${name} created successfully`);
}

async function deleteRunner(runId, context) {
  if (!SUBSCRIPTION_ID) return;

  const name = containerName(runId);
  const credential = new DefaultAzureCredential();
  const client = new ContainerInstanceManagementClient(credential, SUBSCRIPTION_ID);

  try {
    context.log(`Deleting ACI runner: ${name}`);
    await client.containerGroups.beginDeleteAndWait(RESOURCE_GROUP, name);
    context.log(`Runner ${name} deleted`);
  } catch (err) {
    if (err.statusCode === 404) {
      context.log(`Runner ${name} already gone`);
    } else {
      context.error(`Failed to delete runner ${name}: ${err.message}`);
    }
  }
}

app.http('github-webhook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const body = await request.text();
    const signature = request.headers.get('x-hub-signature-256');

    if (!WEBHOOK_SECRET) {
      context.error('GITHUB_RUNNER_WEBHOOK_SECRET not configured — rejecting all requests (fail-closed)');
      return { status: 500, body: 'Webhook secret not configured' };
    }

    if (!verifySignature(body, signature)) {
      context.warn('Invalid webhook signature');
      return { status: 401, body: 'Invalid signature' };
    }

    const event = request.headers.get('x-github-event');
    if (event !== 'workflow_job') {
      return { status: 200, body: 'Ignored event: ' + event };
    }

    const payload = JSON.parse(body);
    const { action, workflow_job: job } = payload;

    const labels = job?.labels || [];
    if (!labels.includes('self-hosted')) {
      return { status: 200, body: 'Not a self-hosted job — skipping' };
    }

    const runId = job?.run_id;
    if (!runId) {
      return { status: 400, body: 'Missing run_id' };
    }

    if (action === 'queued') {
      context.log(`Job queued: run_id=${runId}, labels=${labels.join(',')}`);
      await createRunner(runId, context);
      return { status: 201, body: `Runner created for run ${runId}` };
    }

    if (action === 'completed') {
      context.log(`Job completed: run_id=${runId}`);
      await deleteRunner(runId, context);
      return { status: 200, body: `Runner cleanup for run ${runId}` };
    }

    return { status: 200, body: `Ignored action: ${action}` };
  },
});
