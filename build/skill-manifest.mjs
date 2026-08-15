/**
 * What is in `skill/`, and what ClawHub says it has — in one comparable form.
 *
 * The release workflow used to decide "does the skill need publishing?" by
 * diffing `skill/` against the previous tag. That asks the wrong question. It
 * assumes an unchanged tree means the registry is current, and the registry is
 * a separate system that can disagree for reasons no git diff can see:
 *
 *   - the first version, where there is no previous tag to differ from;
 *   - a release whose publish step was skipped or failed;
 *   - a publish that *succeeded* and uploaded the wrong bytes, which is exactly
 *     what `clawhub@0.23.1` did to 0.0.3 — it dropped the 2.2 MB database,
 *     exited 0, and shipped a skill that could not answer a single query.
 *
 * So ask the registry instead. A `sha256` per path on both sides answers "is
 * what is published the same as what is here", and answers it again after the
 * upload — which is the check that would have caught 0.0.3 before anyone
 * installed it.
 *
 *   node build/skill-manifest.mjs                 # the local tree
 *   node build/skill-manifest.mjs --remote f.json # `clawhub inspect --files --json`
 *   node build/skill-manifest.mjs --verify f.json # every local file, present and identical
 *
 * `--verify` is containment, not equality, and that is deliberate: the registry
 * adds files of its own (`skill-card.md`, `_meta.json`) that were never in
 * `skill/` and must not count as drift. What matters is the direction that can
 * actually break a user — something we shipped missing from, or different on,
 * the registry. It exits 1 and names the files when that happens, so a missing
 * database fails the release rather than the install.
 *
 * A version that does not exist yields an empty manifest, which fails
 * containment for any non-empty skill — so "never published" needs no special
 * case, it is just the most-different case.
 */
import {createHash} from 'node:crypto';
import {readdirSync, readFileSync} from 'node:fs';
import {join, relative, sep} from 'node:path';

const SKILL_DIR = 'skill';

/** Every file under `dir`, recursively, in no particular order. */
function walk(dir) {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/**
 * Paths are normalised to `/` because the registry stores them that way and CI
 * runs a Windows job; a manifest that only matched on Linux would make this
 * check platform-dependent, which is the opposite of the point.
 */
function localManifest() {
  return new Map(
    walk(SKILL_DIR).map((file) => [
      relative(SKILL_DIR, file).split(sep).join('/'),
      createHash('sha256').update(readFileSync(file)).digest('hex'),
    ]),
  );
}

/** `clawhub inspect … --files --json` puts the list on `version.files`. */
function remoteManifest(jsonPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch {
    // A 404 for an unpublished version is not an error here — it is the answer.
    return new Map();
  }
  const files = parsed?.version?.files;
  return new Map(Array.isArray(files) ? files.map((f) => [f.path, f.sha256]) : []);
}

const render = (manifest) =>
  [...manifest]
    .map(([path, sha256]) => `${sha256}  ${path}`)
    .sort()
    .join('\n');

/** Every local file, present on the registry with the same bytes. */
function verify(jsonPath) {
  const local = localManifest();
  const remote = remoteManifest(jsonPath);
  const problems = [];
  for (const [path, sha256] of local) {
    const published = remote.get(path);
    if (published === undefined) problems.push(`missing from the registry: ${path}`);
    else if (published !== sha256) problems.push(`differs on the registry: ${path}`);
  }
  return problems;
}

const [flag, argument] = process.argv.slice(2);
if (flag === '--remote' || flag === '--verify') {
  if (argument === undefined) {
    console.error(`usage: skill-manifest.mjs ${flag} <inspect.json>`);
    process.exit(2);
  }
  if (flag === '--remote') {
    console.log(render(remoteManifest(argument)));
  } else {
    const problems = verify(argument);
    if (problems.length === 0) {
      console.log('ok   every file in skill/ is published, byte for byte');
    } else {
      console.error(`${problems.length} file(s) did not survive the upload:`);
      for (const problem of problems) console.error(`  ${problem}`);
      process.exit(1);
    }
  }
} else if (flag === undefined) {
  console.log(render(localManifest()));
} else {
  console.error(`unknown option ${flag}`);
  process.exit(2);
}
