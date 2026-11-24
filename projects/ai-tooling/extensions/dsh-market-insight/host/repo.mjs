/**
 * GitHub repository helpers shared by the insight model and the fork cache.
 */

const GITHUB_PATTERN = /github\.com\/([^/]+)\/([^/#?\s]+?)(?:\.git)?(?:[/?#].*)?$/i;

/**
 * Parse a repository or homepage URL into its `owner/name` identity.
 * @param url - repository URL from the market index or catalog.
 * @returns `{ owner, name, fullName, key }` where `key` is the lowercase comparison form.
 */
export function parseGithubRepo(url) {
  if (typeof url !== 'string') return undefined;
  const match = GITHUB_PATTERN.exec(url.trim());
  if (match === null) return undefined;
  const owner = match[1];
  const name = match[2].replace(/\.git$/i, '');
  if (owner === '' || name === '') return undefined;
  return { owner, name, fullName: `${owner}/${name}`, key: `${owner}/${name}`.toLowerCase() };
}

/** Normalize any `owner/name` text to its lowercase key, or undefined when malformed. */
export function repoKeyOf(text) {
  if (typeof text !== 'string') return undefined;
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(text.trim());
  return match === null ? undefined : `${match[1]}/${match[2]}`.toLowerCase();
}

/** Build the canonical GitHub URL for a repository key. */
export function repoUrl(key) {
  return `https://github.com/${key}`;
}
