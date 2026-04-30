/**
 * RepoSyncScheduler
 *
 * Periodically checks registered repos for new commits and triggers
 * background re-analysis when changes are detected. Designed to keep
 * the knowledge graph in sync with the remote repository.
 *
 * Enabled via `gitnexus serve --auto-sync` or GITNEXUS_AUTO_SYNC=true.
 * Interval configurable via `--auto-sync-interval` (seconds) or
 * GITNEXUS_AUTO_SYNC_INTERVAL env var (default: 1800 = 30 minutes).
 */

import { spawn } from 'child_process';
import { listRegisteredRepos } from '../storage/repo-manager.js';
import { cloneOrPull, extractRepoName, getCloneDir } from './git-clone.js';
import type { JobManager } from './analyze-job.js';

const DEFAULT_SYNC_INTERVAL_SECS = 1800; // 30 minutes
const MIN_SYNC_INTERVAL_SECS = 60; // minimum 1 minute

export class RepoSyncScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private intervalMs: number;

  constructor(
    private jobManager: JobManager,
    private analyzeRepo: (repoPath: string) => Promise<void>,
    intervalSecs: number = DEFAULT_SYNC_INTERVAL_SECS,
  ) {
    this.intervalMs = Math.max(MIN_SYNC_INTERVAL_SECS, intervalSecs) * 1000;
  }

  start(): void {
    if (this.timer) return;

    console.log(
      `[auto-sync] Enabled — checking every ${Math.round(this.intervalMs / 1000 / 60)} minutes`,
    );

    // Run an immediate check
    this.checkAndSync();

    this.timer = setInterval(() => this.checkAndSync(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async checkAndSync(): Promise<void> {
    if (this.running) return; // prevent overlapping syncs
    this.running = true;

    try {
      const repos = await listRegisteredRepos();
      if (repos.length === 0) return;

      for (const repo of repos) {
        try {
          // Check if this repo has a git remote and a clone dir
          const cloneDir = getCloneDir(repo.name);
          const remoteUrl = await this.getRemoteUrl(cloneDir);
          if (!remoteUrl) continue;

          // Check if there are new commits on the remote
          const hasNewCommits = await this.hasNewCommits(cloneDir, remoteUrl);
          if (!hasNewCommits) {
            if (process.env.DEBUG) {
              console.log(`[auto-sync] ${repo.name} is up to date`);
            }
            continue;
          }

          // Check if this repo is already being analyzed
          const isActive = this.jobManager.listJobs().some((job) => {
            const terminal = job.status === 'complete' || job.status === 'failed';
            if (terminal) return false;
            return (
              job.repoName === repo.name ||
              (job.repoPath && job.repoPath === repo.path)
            );
          });

          if (isActive) {
            console.log(`[auto-sync] Skipping ${repo.name} — analysis already in progress`);
            continue;
          }

          console.log(`[auto-sync] New commits detected for ${repo.name} — pulling and re-analyzing`);

          // Pull latest changes
          await cloneOrPull(remoteUrl, cloneDir);

          // Re-analyze in background
          this.analyzeRepo(cloneDir).catch((err) => {
            console.error(`[auto-sync] Re-analysis failed for ${repo.name}:`, err.message);
          });
        } catch (err: any) {
          console.error(`[auto-sync] Error syncing ${repo.name}:`, err.message);
          // Continue to next repo on error
        }
      }
    } catch (err: any) {
      console.error('[auto-sync] Error listing repos:', err.message);
    } finally {
      this.running = false;
    }
  }

  /** Get the remote URL from a git repo directory. */
  private getRemoteUrl(repoDir: string): Promise<string | null> {
    return new Promise((resolve) => {
      const proc = spawn('git', ['remote', 'get-url', 'origin'], {
        cwd: repoDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });

      let stdout = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.on('close', (code) => {
        resolve(code === 0 ? stdout.trim() : null);
      });

      proc.on('error', () => resolve(null));
    });
  }

  /** Check if the remote has new commits that the local clone doesn't have. */
  private hasNewCommits(repoDir: string, remoteUrl: string): Promise<boolean> {
    return new Promise((resolve) => {
      // Fetch remote refs without pulling
      const fetch = spawn('git', ['fetch', '--dry-run'], {
        cwd: repoDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });

      let stdout = '';
      fetch.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      fetch.on('close', (code) => {
        if (code !== 0) {
          resolve(false);
          return;
        }
        // If fetch --dry-run produced output, there are new refs
        resolve(stdout.trim().length > 0);
      });

      fetch.on('error', () => resolve(false));
    });
  }
}
