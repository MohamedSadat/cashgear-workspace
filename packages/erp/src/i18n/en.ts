// The ERP views' English catalogue: one `erp` section the shell merges into its own catalogues,
// as `@cgw/database` does with `database`. `ar.ts` has exactly the same keys; its type is derived
// from this one. Counts are written "Label: {{count}}", so neither language needs plural forms.
export const en = {
  erp: {
    product: 'Cash Gear ERP',
    block: 'ERP data',
    blockNamed: 'ERP data: {{name}}',
    loading: 'Loading…',
    retry: 'Try again',
    cancel: 'Cancel',
    reference: 'Reference: {{id}}',
    yes: 'Yes',
    no: 'No',

    // Why there is nothing to show.
    signIn: 'Sign in to see ERP data.',
    localWorkspace: 'ERP data needs a workspace kept on your account.',
    noWorkspace: 'Open a workspace to see ERP data.',
    offline: 'ERP data needs a connection.',
    linksLoading: 'Looking for this workspace’s link to Cash Gear ERP…',
    linksFailed: 'This workspace’s links to Cash Gear ERP could not be read.',
    noLink: 'This workspace is not linked to Cash Gear ERP.',
    howToLink:
      'To link it, someone who is an ERP admin and an owner or admin of this workspace chooses “Link Cash Gear Workspace” in Cash Gear ERP.',
    linkGone: 'The link to Cash Gear ERP this block used was removed from the workspace.',
    linkRevoked:
      'Cash Gear ERP ended this workspace’s link to {{company}}. Nothing from it is shown.',
    notChosen: 'No ERP data has been chosen for this block yet.',

    // Connecting.
    company: 'Company',
    notConnected:
      'Connect to Cash Gear ERP to see this data. You see what your own ERP account may see.',
    connect: 'Connect to Cash Gear ERP',
    connectAgain: 'Connect again',
    connectingPopup: 'Connecting to Cash Gear ERP. Finish in the window that opened.',
    connectingBrowser: 'Connecting to Cash Gear ERP. Finish in your browser, then come back here.',
    popupBlocked:
      'The Cash Gear ERP window was blocked. Allow pop-ups for this site, then connect again.',
    browserFailed: 'Your browser could not be opened to connect to Cash Gear ERP.',
    popupClosed: 'The Cash Gear ERP window was closed before you connected.',
    expired: 'Your Cash Gear ERP session ended.',
    ticketInvalid: 'Cash Gear ERP did not accept the connection. Connect again.',
    originDenied: 'Cash Gear ERP does not accept connections from this address.',
    connectFailed: 'Connecting to Cash Gear ERP failed.',
    connectedAs: '{{company}}: {{user}}',

    // Errors while reading.
    noConnectors: 'Your Cash Gear ERP account may not see any ERP data here.',
    noAccess: 'Your Cash Gear ERP account has no access to this data.',
    connectorNotFound: 'Cash Gear ERP no longer offers this data.',
    fieldsHidden: 'Fields of this view your ERP account cannot see, left out: {{count}}',
    noFieldVisible: 'Your Cash Gear ERP account cannot see any field of this view.',
    filterDenied:
      'This view filters by a field your Cash Gear ERP account cannot see, so nothing is shown.',
    filterNotFilterable:
      'This view filters by a field Cash Gear ERP no longer filters by. Change the view’s filter.',
    rateLimited: 'Cash Gear ERP is busy. Try again in {{seconds}} s.',
    rateLimitedNow: 'Cash Gear ERP is busy. Try again in a moment.',
    notAnswering: 'Cash Gear ERP is not answering. Try again in a moment.',
    badAnswer: 'Cash Gear ERP sent an answer this app cannot read.',
    requestInvalid: 'Cash Gear ERP did not accept this view’s settings.',
    failed: 'ERP data could not be loaded.',

    // Choosing what to show.
    chooseData: 'Choose the ERP data to show',
    dataLabel: 'Data',
    changeData: 'Show other data',
    settings: 'View settings',
    fields: 'Fields',
    fieldsCount: 'Fields: {{count}}',
    allFields: 'Show every field',
    filter: 'Filter',
    filterCount: 'Filters: {{count}}',
    search: 'Search',
    searchPlaceholder: 'Search the ERP’s list…',
    conditions: 'Where',
    addCondition: 'Add a condition',
    conditionField: 'Field',
    conditionValue: 'Value of {{field}}',
    removeCondition: 'Remove the condition on {{field}}',
    emptyValue: 'Empty',
    invalidValue: 'Not a valid value for this field.',
    hiddenCondition: 'A condition on a field your ERP account cannot see',
    removeHidden: 'Remove it',
    sort: 'Sort',
    sortCount: 'Sorts: {{count}}',
    addSort: 'Add a sort',
    sortField: 'Sort {{n}} by',
    sortDirection: 'Direction of sort {{n}}',
    ascending: 'Ascending',
    descending: 'Descending',
    removeSort: 'Remove sort {{n}}',
    pageSize: 'Rows a page',
    close: 'Close',

    // The table.
    tableLabel: '{{name}} from Cash Gear ERP',
    scrollLabel: 'Records of {{name}}',
    refresh: 'Refresh',
    loadedAt: 'Loaded {{time}}',
    noRecords: 'No records match.',
    range: 'Records {{from}}–{{to}} of {{total}}',
    previousPage: 'Back',
    nextPage: 'Next',
    pages: 'Pages',

    // The link screen (#/erp-link/{ticket}).
    linkTitle: 'Link a workspace to Cash Gear ERP',
    linkIntro:
      'Cash Gear ERP asked to link one of your workspaces to its company. Everyone in the workspace can then add ERP data to pages, and each person sees only what their own ERP account may see.',
    linkNoTicket:
      'This link request is no longer here. In Cash Gear ERP, choose “Link Cash Gear Workspace” again.',
    linkSignIn: 'Sign in to choose the workspace to link.',
    linkSignInNote:
      'Signing in leaves this page, and the link request goes with it: after signing in, choose “Link Cash Gear Workspace” in Cash Gear ERP again.',
    signInButton: 'Sign in',
    linkNoWorkspace:
      'You own or administer no workspace kept on your account, so there is nothing to link.',
    linkChoose: 'Workspace to link',
    linkConfirm: 'Link this workspace',
    linkWorking: 'Linking…',
    linkDone: '{{company}} is now linked to {{workspace}}.',
    linkExists: '{{company}} was already linked to {{workspace}}.',
    linkOpenSettings: 'Open settings',
    linkExpired:
      'This link request expired or was used already. In Cash Gear ERP, choose “Link Cash Gear Workspace” again.',
    linkStartAgain: 'Then choose “Link Cash Gear Workspace” in Cash Gear ERP again.',
    linkOff: 'Cash Gear ERP has Workspace turned off for this company.',
    linkDenied: 'Cash Gear ERP did not allow this link.',
    linkRecordFailed:
      'Cash Gear ERP recorded the link, but this workspace could not keep it. Try again.',
    linkForbidden: 'Only owners and admins of the workspace may link it.',
    linkStale:
      'This workspace still has its earlier link to that company, which Cash Gear ERP has ended. Unlink it in settings, then link again from Cash Gear ERP.',
    linkOffline: 'Linking needs a connection.',
    linkCancelled: 'Nothing was linked.',

    // Settings.
    settingsTitle: 'Cash Gear ERP',
    settingsIntro:
      'Pages in this workspace can show data from the Cash Gear ERP companies linked here. Each person connects with their own ERP account, in each tab.',
    settingsNone: 'This workspace is not linked to any Cash Gear ERP company.',
    settingsLinkedBy: 'Linked by {{name}} on {{date}}',
    unlink: 'Unlink',
    unlinkNamed: 'Unlink {{company}}',
    unlinkConfirm:
      'Unlink {{company}}? ERP data blocks that use it stop showing anything. Cash Gear ERP keeps its own record of the link until an ERP admin ends it there.',
    unlinkFailed: 'The link could not be removed.',
    disconnect: 'Disconnect',
    disconnectNamed: 'Disconnect from {{company}}',
    connectedHere: 'Connected in this tab as {{user}}',
    notConnectedHere: 'Not connected in this tab',
    openErp: 'Open Cash Gear ERP',
  },
};
