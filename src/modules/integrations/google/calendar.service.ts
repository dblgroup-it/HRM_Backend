import { Injectable, Logger } from '@nestjs/common';
import { google, calendar_v3 } from 'googleapis';
import { randomUUID } from 'node:crypto';

import { GoogleAuthService } from './google-auth.service';

/** All interview times are entered and displayed in Bangladesh time. */
const TIMEZONE = 'Asia/Dhaka';
const DEFAULT_DURATION_MIN = 60;

export interface CalendarEventInput {
  summary: string;
  description?: string;
  start: Date;
  durationMinutes?: number;
  /** Attendee email addresses (panelists + candidate). Invalid ones are skipped. */
  attendees: string[];
  /** Physical venue; ignored when a Meet link is requested. */
  location?: string | null;
  /** Attach an auto-generated Google Meet link (online interviews). */
  withMeet: boolean;
}

export interface CalendarEventResult {
  eventId: string;
  meetLink: string | null;
  htmlLink: string | null;
}

/**
 * Google Calendar on the recruitment account: interview rounds become real
 * calendar events (with Meet links for online ones) that invite the panel and
 * the candidate by email. All calls are best-effort — calendar failures must
 * never block scheduling, so callers treat a null result as "not synced".
 */
@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(private readonly auth: GoogleAuthService) {}

  isConfigured(): boolean {
    return this.auth.isConfigured();
  }

  private api(): calendar_v3.Calendar {
    return google.calendar({
      version: 'v3',
      auth: this.auth.getAuthorizedClient(),
    });
  }

  async createEvent(
    input: CalendarEventInput,
  ): Promise<CalendarEventResult | null> {
    if (!this.isConfigured()) return null;
    try {
      const res = await this.api().events.insert({
        calendarId: 'primary',
        sendUpdates: 'all',
        conferenceDataVersion: input.withMeet ? 1 : 0,
        requestBody: this.body(input),
      });
      const ev = res.data;
      return {
        eventId: ev.id ?? '',
        meetLink: this.meetLinkOf(ev),
        htmlLink: ev.htmlLink ?? null,
      };
    } catch (err) {
      this.logger.warn(
        `Calendar event create failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  async updateEvent(
    eventId: string,
    input: CalendarEventInput,
  ): Promise<CalendarEventResult | null> {
    if (!this.isConfigured()) return null;
    try {
      const res = await this.api().events.patch({
        calendarId: 'primary',
        eventId,
        sendUpdates: 'all',
        conferenceDataVersion: input.withMeet ? 1 : 0,
        requestBody: this.body(input, /* forUpdate */ true),
      });
      const ev = res.data;
      return {
        eventId: ev.id ?? eventId,
        meetLink: this.meetLinkOf(ev),
        htmlLink: ev.htmlLink ?? null,
      };
    } catch (err) {
      this.logger.warn(
        `Calendar event update failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Cancels the event and emails attendees the cancellation. Best-effort. */
  async cancelEvent(eventId: string): Promise<void> {
    if (!this.isConfigured() || !eventId) return;
    try {
      await this.api().events.delete({
        calendarId: 'primary',
        eventId,
        sendUpdates: 'all',
      });
    } catch (err) {
      this.logger.warn(
        `Calendar event cancel failed: ${(err as Error).message}`,
      );
    }
  }

  private body(
    input: CalendarEventInput,
    forUpdate = false,
  ): calendar_v3.Schema$Event {
    const start = input.start;
    const end = new Date(
      start.getTime() +
        (input.durationMinutes ?? DEFAULT_DURATION_MIN) * 60_000,
    );
    const attendees = [...new Set(input.attendees)]
      .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
      .map((email) => ({ email }));
    return {
      summary: input.summary,
      description: input.description,
      location: input.withMeet ? undefined : (input.location ?? undefined),
      start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
      end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
      attendees,
      reminders: { useDefault: true },
      // Only request a fresh Meet room on create — patching with a new
      // createRequest would replace the existing room.
      ...(input.withMeet && !forUpdate
        ? {
            conferenceData: {
              createRequest: {
                requestId: randomUUID(),
                conferenceSolutionKey: { type: 'hangoutsMeet' },
              },
            },
          }
        : {}),
    };
  }

  private meetLinkOf(ev: calendar_v3.Schema$Event): string | null {
    return (
      ev.hangoutLink ??
      ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')
        ?.uri ??
      null
    );
  }
}
