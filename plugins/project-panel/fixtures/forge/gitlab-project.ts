// `glab api projects/<url-encoded path>` (glab 1.99.0), sanitised and cut to the fields that matter.
import { GITLAB_HOST, GITLAB_PATH, GITLAB_WEB } from './gitlab-mr-list'

export const project = {
  id: 256,
  name: 'scanner',
  path: 'scanner',
  path_with_namespace: GITLAB_PATH,
  default_branch: 'main',
  web_url: GITLAB_WEB,
  ssh_url_to_repo: `git@${GITLAB_HOST}:${GITLAB_PATH}.git`,
  http_url_to_repo: `${GITLAB_WEB}.git`,
  visibility: 'private',
}
