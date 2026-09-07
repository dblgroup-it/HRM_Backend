import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { MemoryCacheService } from '../../common/cache/memory-cache.service';

export interface MasterData {
  departments: string[];
  /** department -> its sections */
  departmentSections: Record<string, string[]>;
  /** Every sub-section, used when a department+section pair has no mapping. */
  subSections: string[];
  /** "Department||Section" -> its sub-sections */
  sectionSubSections: Record<string, string[]>;
  designations: string[];
  /** designation -> the grades valid for it */
  designationGrades: Record<string, string[]>;
  zones: string[];
}

/** Key for the sectionSubSections map — mirrors how the rows are seeded. */
export function sectionKey(department: string, section: string): string {
  return `${department}||${section}`;
}

const CACHE_KEY = 'master-data:all';
/** Vocabulary changes rarely; a long TTL keeps the form snappy. */
const CACHE_TTL = 10 * 60_000;

@Injectable()
export class MasterDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: MemoryCacheService,
  ) {}

  getAll(): Promise<MasterData> {
    return this.cache.wrap(CACHE_KEY, CACHE_TTL, () => this.load());
  }

  /** Drop the cached vocabulary (call after any master_options change). */
  invalidate(): void {
    this.cache.delete(CACHE_KEY);
  }

  private async load(): Promise<MasterData> {
    const rows = await this.prisma.masterOption.findMany({
      where: { isActive: true },
      orderBy: [{ kind: 'asc' }, { parent: 'asc' }, { sortOrder: 'asc' }],
      select: { kind: true, value: true, parent: true },
    });

    const departments: string[] = [];
    const designations: string[] = [];
    const zones: string[] = [];
    const subSections: string[] = [];
    const departmentSections: Record<string, string[]> = {};
    const sectionSubSections: Record<string, string[]> = {};
    const designationGrades: Record<string, string[]> = {};

    for (const r of rows) {
      switch (r.kind) {
        case 'department':
          departments.push(r.value);
          break;
        case 'designation':
          designations.push(r.value);
          break;
        case 'zone':
          zones.push(r.value);
          break;
        case 'section':
          (departmentSections[r.parent] ??= []).push(r.value);
          break;
        case 'subsection':
          // Empty parent = the flat master list; otherwise "Department||Section".
          if (r.parent) (sectionSubSections[r.parent] ??= []).push(r.value);
          else subSections.push(r.value);
          break;
        case 'grade':
          (designationGrades[r.parent] ??= []).push(r.value);
          break;
      }
    }

    return {
      departments,
      departmentSections,
      subSections,
      sectionSubSections,
      designations,
      designationGrades,
      zones,
    };
  }
}
