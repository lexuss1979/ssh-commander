// Только tag-workflow. Сетевой сбой не трактуется как отсутствие опубликованной версии.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const image = 'ghcr.io/lexuss1979/ssh-commander';
const repository = 'lexuss1979/ssh-commander';
const { GITHUB_REF_NAME: tag, GITHUB_SHA: sha, GITHUB_TOKEN: token, GITHUB_ACTOR: actor } = process.env;
assert.match(tag ?? '', /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
assert(token && actor);
const version = tag.slice(1);
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 2_400_000, maxBuffer: 16 * 1024 * 1024 });
// Checkout и проверки обязаны относиться к тому же коммиту, включая annotated tag.
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(revision, sha);
async function manifest(ref) {
  const auth = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`, {
    headers: { Authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString('base64')}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(auth.status, 200, 'Registry authentication failed');
  const bearer = (await auth.json()).token;
  const response = await fetch(`https://ghcr.io/v2/${repository}/manifests/${ref}`, {
    headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) {
    const body = await response.json();
    assert(body.errors?.some(e => ['MANIFEST_UNKNOWN', 'NAME_UNKNOWN'].includes(e.code)), 'Unexpected registry 404');
    return null;
  }
  assert.equal(response.status, 200, 'Cannot inspect published image');
  const digest = response.headers.get('docker-content-digest');
  assert.match(digest ?? '', /^sha256:[a-f0-9]{64}$/);
  return { digest, body: await response.json() };
}
const published = await manifest(version);
const candidateTag = `sha-${sha}`;
let candidate = published ?? await manifest(candidateTag);
if (!candidate) {
  // Кандидат ещё не версия и не latest. Повтор использует этот же digest.
  docker('buildx', 'build', '--platform', 'linux/amd64,linux/arm64', '--push',
    '--build-arg', `VERSION=${version}`, '--build-arg', `REVISION=${sha}`,
    '--tag', `${image}:${candidateTag}`, '.');
  candidate = await manifest(candidateTag);
}
assert(candidate, 'Candidate missing after build');
const platforms = candidate.body.manifests?.map(m => `${m.platform.os}/${m.platform.architecture}`);
for (const platform of ['linux/amd64', 'linux/arm64']) {
  assert(platforms?.includes(platform), `Missing ${platform}`);
  const ref = `${image}@${candidate.digest}`;
  docker('pull', '--platform', platform, ref);
  const info = JSON.parse(docker('image', 'inspect', ref))[0];
  assert.equal(info.Architecture, platform.split('/')[1]);
  assert.equal(info.Config.Labels['org.opencontainers.image.revision'], sha, 'Existing image belongs to another commit');
  assert.equal(info.Config.Labels['org.opencontainers.image.version'], version);
  execFileSync(process.execPath, ['scripts/smoke-image.mjs', ref, platform], { stdio: 'inherit', timeout: 300_000 });
}
if (!published) docker('buildx', 'imagetools', 'create', '--tag', `${image}:${version}`, `${image}@${candidate.digest}`);
assert.equal((await manifest(version))?.digest, candidate.digest, 'Published digest differs');
// Повтор старого выпуска не должен откатывать latest на более раннюю версию.
const latest = await manifest('latest');
let promote = true;
if (latest) {
  docker('pull', '--platform', 'linux/amd64', `${image}@${latest.digest}`);
  const labels = JSON.parse(docker('image', 'inspect', `${image}@${latest.digest}`))[0].Config.Labels;
  const previous = labels['org.opencontainers.image.version'];
  assert.match(previous ?? '', /^\d+\.\d+\.\d+$/);
  const a = version.split('.').map(Number), b = previous.split('.').map(Number);
  const differing = a.findIndex((n, i) => n !== b[i]);
  promote = differing === -1 || a[differing] > b[differing];
}
if (promote) docker('buildx', 'imagetools', 'create', '--tag', `${image}:latest`, `${image}@${candidate.digest}`);
const summary = `Version: ${version}\nCommit: ${sha}\nImage: ${image}@${candidate.digest}\nPlatforms: linux/amd64 (native), linux/arm64 (QEMU)\nLatest updated: ${promote}\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
