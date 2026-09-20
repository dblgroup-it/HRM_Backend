import { BadRequestException } from '@nestjs/common';

const MB = 1024 * 1024;

type MulterFile = { mimetype: string; originalname: string };
type FilterCb = (error: Error | null, acceptFile: boolean) => void;

/**
 * `types` -> the sentence a rejected upload is told.
 *
 * Derived rather than fixed: every narrower list used to be described as
 * "PDF, Word, Excel or images", so a candidate refused for sending a .docx
 * was told .docx was allowed. Callers pass `label` where the set has a name
 * worth using; otherwise the extensions are read off the list itself.
 */
function describe(types: string[]): string {
  if (types.length === 1 && types[0] === 'application/pdf') return 'PDF only';
  const names: Record<string, string> = {
    'application/pdf': 'PDF',
    'application/msword': 'Word',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      'Word',
    'application/vnd.ms-excel': 'Excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      'Excel',
    'text/csv': 'CSV',
    'image/png': 'PNG',
    'image/jpeg': 'JPG',
    'image/jpg': 'JPG',
    'image/webp': 'WebP',
  };
  const seen: string[] = [];
  for (const t of types) {
    const n = names[t];
    if (n && !seen.includes(n)) seen.push(n);
  }
  if (!seen.length) return 'a supported file type';
  if (seen.length === 1) return seen[0];
  return `${seen.slice(0, -1).join(', ')} or ${seen[seen.length - 1]}`;
}

function allow(types: string[], label = describe(types)) {
  return (_req: unknown, file: MulterFile, cb: FilterCb): void => {
    if (types.includes(file.mimetype)) cb(null, true);
    else
      cb(
        new BadRequestException(
          `Unsupported file type "${file.mimetype || 'unknown'}". Allowed: ${label}.`,
        ),
        false,
      );
  };
}

export const DOC_MIME = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
  'image/jpg',
];

export const SHEET_MIME = [
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
];

export const IMAGE_MIME = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
];

/**
 * E-signatures: PNG and JPEG only.
 *
 * Narrower than IMAGE_MIME on purpose. A signature is cropped in the browser
 * and re-encoded to PNG before it is sent, so nothing legitimate arrives as
 * WebP — and a signature ends up printed on offer letters and approval sheets,
 * where the formats every viewer and printer handles without surprise are the
 * two oldest ones.
 */
export const SIGNATURE_MIME = ['image/png', 'image/jpeg', 'image/jpg'];

/** E-signature upload — 2 MB, PNG/JPEG only. */
export const SIGNATURE_UPLOAD = {
  limits: { fileSize: 2 * MB, files: 1 },
  fileFilter: allow(SIGNATURE_MIME),
};

/** CVs and attachments — 10 MB, PDF/Word/images. */
export const DOC_UPLOAD = {
  limits: { fileSize: 10 * MB, files: 1 },
  fileFilter: allow(DOC_MIME),
};

/** CVs, offer letters, joining docs — PDF only, 5 MB. */
export const PDF_UPLOAD = {
  limits: { fileSize: 5 * MB, files: 1 },
  fileFilter: allow(['application/pdf']),
};

/**
 * A joining document: a PDF or a photograph.
 *
 * Most of the checklist is paper the candidate is holding, so a phone photo
 * of a certificate is what they actually have — insisting on PDF sent them
 * off to find a converter. The same set covers the one item that is always a
 * picture, their signature; which labels may be an image is decided by the
 * service, not here, because multer only knows what a file is.
 */
export const JOINING_DOC_UPLOAD = {
  limits: { fileSize: 5 * MB, files: 1 },
  fileFilter: allow(['application/pdf', ...SIGNATURE_MIME]),
};

/** Profile pictures — 2 MB, images only. */
export const IMAGE_UPLOAD = {
  limits: { fileSize: 2 * MB, files: 1 },
  fileFilter: allow(IMAGE_MIME),
};

/** Requisition attachments — 15 MB, docs + spreadsheets. */
export const ATTACHMENT_UPLOAD = {
  limits: { fileSize: 15 * MB, files: 1 },
  fileFilter: allow([...DOC_MIME, ...SHEET_MIME]),
};
