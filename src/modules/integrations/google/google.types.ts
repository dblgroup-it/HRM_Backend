/**
 * Persisted (on Requisition.drive) map of the Google Drive folder tree for a
 * requisition's recruitment workspace.
 */
export interface RequisitionDriveMap {
  rootFolderId: string;
  rootFolderUrl: string;
  /** 01 All CVs — shared "anyone with link" so it doubles as the collection link. */
  allCvFolderId: string;
  allCvFolderUrl: string;
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
