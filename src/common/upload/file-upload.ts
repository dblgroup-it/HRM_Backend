import { BadRequestException } from '@nestjs/common';

const MB = 1024 * 1024;

type MulterFile = { mimetype: string; originalname: string };
type FilterCb = (error: Error | null, acceptFile: boolean) => void;

function allow(types: string[]) {
  return (_req: unknown, file: MulterFile, cb: FilterCb): void => {
    if (types.includes(file.mimetype)) cb(null, true);
    else
      cb(
        new BadRequestException(
          `Unsupported file type "${file.mimetype || 'unknown'}". Allowed: PDF, Word, Excel or images.`,
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

/** CVs / joining documents — 10 MB, PDF/Word/images. */
export const DOC_UPLOAD = {
  limits: { fileSize: 10 * MB, files: 1 },
  fileFilter: allow(DOC_MIME),
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
