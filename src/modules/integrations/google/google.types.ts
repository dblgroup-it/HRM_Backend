/**
 * Persisted (on Requisition.drive) map of the Google Drive folder tree for a
 * requisition's recruitment workspace.
 */
export interface RequisitionDriveMap {
  rootFolderId: string;
  rootFolderUrl: string;
  /** 01 All CVs — private to recruitment; candidates submit via the apply page. */
  allCvFolderId: string;
  allCvFolderUrl: string;
  /** 02 AI Shortlisted — CVs the AI screen advanced. */
  aiShortlistedFolderId?: string;
  shortlistedFolderId: string;
  interviewFolderId: string;
  finalFolderId: string;
  joiningFolderId: string;
  createdAt: string;
}

export interface DriveTreeInput {
  code: string;
  designation: string;
  unit: string;
  department: string;
}
