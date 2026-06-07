import { IsNotEmpty, IsString } from 'class-validator';

export class SeatLookupDto {
  @IsString()
  @IsNotEmpty()
  unit!: string;

  @IsString()
  @IsNotEmpty()
  department!: string;

  @IsString()
  @IsNotEmpty()
  designation!: string;
}
