import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { SandboxService } from './sandbox.service';

const run = promisify(execFile);

/**
 * "Deploy to Prod" on the dev server.
 *
 * Only starts deploy/ubuntu/promote-to-prod.sh in the background and reads
 * what it reports — every decision (is dev clean, does it build on live,
 * deploy, roll back, push) is the script's, so it behaves the same whether
 * the button or a person at the server starts it.
 */
@Injectable()
export class PromoteService {
  private readonly logger = new Logger('Promote');
  private readonly home = os.homedir();
  readonly paths = {
    prod: process.env.PROD_DIR || path.join(this.home, 'HRM_Backend'),
    prodFrontend:
      process.env.PROD_FRONTEND_DIR || path.join(this.home, 'HRM_Frontend'),
    dev: process.env.DEV_DIR || process.cwd(),
    devFrontend:
      process.env.DEV_FRONTEND_DIR ||
      path.join(process.cwd(), '..', 'HRM_Frontend'),
    state:
      process.env.PROMOTE_STATE_DIR || path.join(this.home, 'dev', 'promote'),
    autodeploy:
      process.env.AUTODEPLOY_DIR || path.join(this.home, 'dev', 'autodeploy'),
  };

  constructor(private readonly sandbox: SandboxService) {}

  private requireSandbox() {
    if (!this.sandbox.enabled) throw new NotFoundException();
  }

  private async git(dir: string, args: string[]): Promise<string> {
    const { stdout } = await run('git', ['-C', dir, ...args], {
      timeout: 15_000,
    });
    return stdout.trim();
  }

  /** One repo: what is live, what dev would put there, and the commits between. */
  private async repoPlan(label: string, live: string, dev: string) {
    try {
      const from = await this.git(live, ['rev-parse', 'HEAD']);
      const to = await this.git(dev, ['rev-parse', 'HEAD']);
      const dirty = (await this.git(dev, ['status', '--porcelain'])).length > 0;
      const devBranch = await this.git(dev, [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ]);
      // The dev checkout has every commit live has, if it builds on live.
      let buildsOnLive = true;
      try {
        await this.git(dev, ['merge-base', '--is-ancestor', from, to]);
      } catch {
        buildsOnLive = false;
      }
      const log =
        from === to || !buildsOnLive
          ? ''
          : await this.git(dev, [
              'log',
              '--format=%h%x09%s%x09%an%x09%cr',
              `${from}..${to}`,
              '-n',
              '60',
            ]);
      return {
        label,
        live: from.slice(0, 7),
        dev: to.slice(0, 7),
        devBranch,
        dirty,
        buildsOnLive,
        commits: log
          ? log.split('\n').map((l) => {
              const [sha, subject, author, when] = l.split('\t');
              return { sha, subject, author, when };
            })
          : [],
      };
    } catch (e) {
      return { label, error: (e as Error).message.split('\n')[0] };
    }
  }

  private readState(): Record<string, unknown> | null {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.paths.state, 'state.json'), 'utf8'),
      );
    } catch {
      return null;
    }
  }

  private running(): boolean {
    return fs.existsSync(path.join(this.paths.state, 'lock'));
  }

  /** The preview (what would go live) and the last run, with its log. */
  async status() {
    this.requireSandbox();
    const [backend, frontend] = await Promise.all([
      this.repoPlan('Backend', this.paths.prod, this.paths.dev),
      this.repoPlan(
        'Frontend',
        this.paths.prodFrontend,
        this.paths.devFrontend,
      ),
    ]);
    const last = this.readState();
    let logTail = '';
    const logPath = typeof last?.log === 'string' ? last.log : null;
    if (logPath && logPath.startsWith(this.paths.state)) {
      try {
        logTail = fs
          .readFileSync(logPath, 'utf8')
          .split('\n')
          .slice(-300)
          .join('\n');
      } catch {
        /* rotated away */
      }
    }
    // The dev site's own updates (deploy/ubuntu/dev-autodeploy.sh, every 2 min).
    let autodeploy: Record<string, unknown> | null = null;
    try {
      autodeploy = JSON.parse(
        fs.readFileSync(path.join(this.paths.autodeploy, 'state.json'), 'utf8'),
      );
    } catch {
      /* not set up yet */
    }
    return {
      running: this.running(),
      plan: { backend, frontend },
      last,
      logTail,
      autodeploy,
    };
  }

  /** Start the promotion in the background; the page polls `status`. */
  async start(actor: { id: string; name: string }) {
    this.requireSandbox();
    if (this.running())
      throw new ConflictException('A deploy is already running.');
    const script = path.join(
      this.paths.dev,
      'deploy',
      'ubuntu',
      'promote-to-prod.sh',
    );
    if (!fs.existsSync(script))
      throw new BadRequestException(`Missing ${script}.`);
    const { plan } = await this.status();
    for (const p of [plan.backend, plan.frontend]) {
      if ('error' in p && p.error)
        throw new BadRequestException(`${p.label}: ${p.error}`);
      if ('dirty' in p && p.dirty)
        throw new BadRequestException(
          `${p.label} on dev has uncommitted changes.`,
        );
      if ('buildsOnLive' in p && !p.buildsOnLive) {
        throw new BadRequestException(
          `${p.label}: live has commits dev does not. Merge main into dev, test, then deploy.`,
        );
      }
    }
    fs.mkdirSync(this.paths.state, { recursive: true });
    // Detached: the deploy must outlive this request, and must not die if
    // the dev app restarts. The script cleans its own environment.
    const child = spawn('bash', [script], {
      detached: true,
      stdio: 'ignore',
      cwd: this.paths.dev,
      env: {
        HOME: this.home,
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        PROD_DIR: this.paths.prod,
        PROD_FRONTEND_DIR: this.paths.prodFrontend,
        DEV_DIR: this.paths.dev,
        DEV_FRONTEND_DIR: this.paths.devFrontend,
        STATE_DIR: this.paths.state,
      },
    });
    child.unref();
    this.logger.warn(`${actor.name} started a deploy to the live site`);
    return { started: true };
  }
}
