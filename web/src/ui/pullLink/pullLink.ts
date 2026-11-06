/** The number in a pull request's address on a host. */
export const pullNumberOf = (href: string): number | null => {
  const match = /^https:\/\/[^/]+\/[^/]+\/[^/]+\/pulls?\/(\d+)(?:[/?#].*)?$/.exec(href.trim());
  return match ? Number(match[1]) : null;
};

/** The `owner/repo` a pull request address names, for display. */
export function pullRepositoryLabel(url: string): string | null {
  try {
    const [owner, repo] = new URL(url).pathname.split("/").filter(Boolean);
    return owner && repo ? `${owner}/${repo}` : null;
  } catch {
    return null;
  }
}

/** Host and repository, compared without case. */
function pullRepositoryKey(url: string): string | null {
  const repository = pullRepositoryLabel(url);
  if (!repository) return null;
  try {
    return `${new URL(url).host.toLowerCase()}/${repository.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** Whether two addresses name the same pull request in the same repository. */
export function samePullRequest(left: string, right: string): boolean {
  const number = pullNumberOf(left);
  const repository = pullRepositoryKey(left);
  return (
    number !== null &&
    number === pullNumberOf(right) &&
    repository !== null &&
    repository === pullRepositoryKey(right)
  );
}
