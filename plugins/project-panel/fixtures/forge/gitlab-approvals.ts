// `glab api projects/<path>/merge_requests/<iid>/approvals` (glab 1.99.0), sanitised.
export const notApproved = { user_has_approved: false, user_can_approve: true, approved: false, approved_by: [] }
export const approved = { user_has_approved: false, user_can_approve: true, approved: true, approved_by: [{ user: { username: 'dev-two' } }] }
