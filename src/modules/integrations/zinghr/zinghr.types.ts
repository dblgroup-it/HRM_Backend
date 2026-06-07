export interface ZingHrAttribute {
  AttributeTypeID: string;
  AttributeTypeUnitDesc: string | null;
}

export interface ZingHrEmployee {
  EmployeeCode: string;
  EmployeeStatus: string;
  FirstName: string | null;
  LastName: string | null;
  Email: string | null;
  Mobile: string | null;
  Gender: string | null;
  DateofBirth: string | null;
  DateofJoining: string | null;
  ExitDate: string | null;
  ReportingManagerName: string | null;
  ReportingManagerCode: string | null;
  Attributes?: ZingHrAttribute[];
}

export interface ZingHrResponse {
  Employees?: ZingHrEmployee[];
}

export interface ZingHrSyncResult {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  total: number;
}

/** ZingHR attribute type IDs (per the Employee Master API spec). */
export const ZING_ATTR = {
  LEGAL_ENTITY: '45', // e.g. "DBL Ceramics Ltd."
  LOCATION: '48', // e.g. "Ceramics Corporate"
  PAYROLL_UNIT: '50', // e.g. "DBL Ceramics Ltd."  → used as the unit
  DIVISION: '52',
  DEPARTMENT: '53',
  SECTION: '54',
  DESIGNATION: '56',
  GRADE: '57', // e.g. "M7"
  CATEGORY: '58', // e.g. "Management" / "Executive"
  REGION: '59',
  UNIT_CODE: '77', // e.g. "DCL" (short code)
} as const;
