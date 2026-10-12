// `glab mr view <iid> -F json` (glab 1.99.0), sanitised and cut to what the forge reads: the merge request's
// own fields plus `head_pipeline` (the list has none). The recorded pipeline object is kept in shape:
// `status`, `source: 'merge_request_event'`, `ref: 'refs/merge-requests/<iid>/head'`, a `detailed_status`.
import { GITLAB_WEB, mrRow, shaOf } from './gitlab-mr-list'

export type PipelineStatus =
  | 'success'
  | 'failed'
  | 'running'
  | 'pending'
  | 'created'
  | 'waiting_for_resource'
  | 'preparing'
  | 'scheduled'
  | 'manual'
  | 'canceled'
  | 'skipped'

/** The view of merge request `iid` whose head pipeline is in `status` (null = it has none). */
export function mrView(iid: number, status: PipelineStatus | null, over: Record<string, unknown> = {}) {
  return {
    ...mrRow(iid, { state: 'opened', merged_at: null }),
    head_pipeline:
      status === null
        ? null
        : {
            id: 22000 + iid,
            iid: 1000 + iid,
            project_id: 256,
            status,
            source: 'merge_request_event',
            ref: `refs/merge-requests/${iid}/head`,
            sha: shaOf(iid),
            web_url: `${GITLAB_WEB}/-/pipelines/${22000 + iid}`,
            detailed_status: { group: status, label: status, text: status, has_details: true },
          },
    ...over,
  }
}
