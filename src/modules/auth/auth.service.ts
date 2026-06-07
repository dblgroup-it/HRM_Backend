import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { User } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './strategies/jwt.strategy';

/** User shape returned to the client (frontend-friendly, lowercase role). */
export interface UserResponse {
  id: string;
  employeeCode: string;
  name: string;
  email: string | null;
  role: string;
  jobTitle: string | null;
  department: string | null;
  unit: string | null;
  avatarUrl: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto): Promise<{ token: string; user: UserResponse }> {
    const identifier = dto.identifier.trim();
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: identifier }, { employeeCode: identifier }] },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return { token: this.sign(user), user: await this.buildUser(user) };
  }

  async me(userId: string): Promise<UserResponse> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    return this.buildUser(user);
  }

  private sign(user: User): string {
    const payload: JwtPayload = {
      sub: user.id,
      employeeCode: user.employeeCode,
      role: user.role,
    };
    return this.jwt.sign(payload);
  }

  private async buildUser(user: User): Promise<UserResponse> {
    const profile = await this.prisma.employee.findUnique({
      where: { userId: user.id },
    });
    return {
      id: user.id,
      employeeCode: user.employeeCode,
      name: user.name,
      email: user.email,
      role: user.role.toLowerCase(),
      jobTitle: profile?.designation ?? null,
      department: profile?.department ?? null,
      unit: profile?.unitName ?? null,
      avatarUrl: null,
    };
  }
}
