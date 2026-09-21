import { NotificationsService } from './notifications.service';

/**
 * A notification may carry its own email renderer. It is a function, so it
 * must never reach Prisma, and it must replace the generic wrapper — not add
 * a second message.
 */
describe('NotificationsService — custom email', () => {
  const setup = () => {
    const create = jest.fn(async ({ data }) => ({ id: 'n1', ...data }));
    const send = jest.fn(async () => ({ messageId: 'm1' }));
    const prisma = {
      notification: { create },
      user: {
        findUnique: jest.fn(async () => ({
          email: 'panel@dbl-group.com',
          name: 'Ayesha Rahman',
          emailNotifications: true,
        })),
      },
    };
    const service = new NotificationsService(
      prisma as never,
      { emitToUser: jest.fn() } as never,
      { isConfigured: () => true, send } as never,
      { get: () => 'https://hrm.dbl' } as never,
    );
    return { service, create, send };
  };
  const flush = () => new Promise((r) => setImmediate(r));

  it('stores the notification without the renderer and mails its output', async () => {
    const { service, create, send } = setup();
    const email = jest.fn(() => ({
      subject: 'S',
      html: '<p>H</p>',
      text: 'T',
    }));
    await service.notify('u1', {
      type: 'interview_assigned',
      title: 'Title',
      message: 'Message',
      link: '/my-interviews',
      email,
    });
    await flush();

    expect(create.mock.calls[0][0].data).toEqual({
      userId: 'u1',
      type: 'interview_assigned',
      title: 'Title',
      message: 'Message',
      link: '/my-interviews',
    });
    expect(email).toHaveBeenCalledWith({
      name: 'Ayesha Rahman',
      origin: 'https://hrm.dbl',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      to: 'panel@dbl-group.com',
      subject: 'S',
      html: '<p>H</p>',
      text: 'T',
    });
  });

  it('still uses the generic wrapper when no renderer is given', async () => {
    const { service, send } = setup();
    await service.notify('u1', {
      type: 't',
      title: 'Title',
      message: 'Message',
    });
    await flush();
    expect(send.mock.calls[0][0].subject).toBe('Title | DBL HRM');
  });
});
