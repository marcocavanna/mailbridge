import {
  disableSchedule,
  enableSchedule,
  runScheduleNow,
  showScheduleLogs,
  showScheduleStatus,
} from './schedule-actions.js';
import { listAccounts, showStatus, testAccount } from './account-read-actions.js';
import { addAccountFlow, editAccountFlow, removeAccountFlow } from './account-write-actions.js';
import { prompts, required } from './prompt-helpers.js';
import { renderIntro } from './shell.js';
import { startUpdateCheck } from './update-check.js';
import { runSyncWithFeedback, showSyncState, syncFlow } from './sync-actions.js';

/* --------
 * Interactive menu
 * -------- */

async function accountMenu(): Promise<void> {
  const choice = required(await prompts.select({
    message: 'Accounts',
    options: [
      { value: 'list', label: 'List', hint: 'id, address, credential and mirror state' },
      { value: 'status', label: 'Detailed status', hint: 'size on disk, messages, last sync' },
      { value: 'test', label: 'Test the connection', hint: 'IMAP and SMTP, sending nothing' },
      { value: 'add', label: 'Add' },
      { value: 'edit', label: 'Edit', hint: 'fields, password or mirror' },
      { value: 'remove', label: 'Remove' },
    ],
  }));

  switch (choice) {
    case 'list':
      await listAccounts();
      break;
    case 'status':
      await showStatus();
      break;
    case 'test':
      await testAccount();
      break;
    case 'add':
      await addAccountFlow();
      break;
    case 'edit':
      await editAccountFlow();
      break;
    case 'remove':
      await removeAccountFlow();
      break;
  }
}

async function scheduleMenu(): Promise<void> {
  const choice = required(await prompts.select({
    message: 'Scheduled sync',
    options: [
      { value: 'status', label: 'Status', hint: 'whether it is on, at what cadence, last outcome' },
      { value: 'enable', label: 'Enable or reconfigure', hint: 'cadence and accounts' },
      { value: 'run', label: 'Run now', hint: 'in its real environment, not in the terminal' },
      { value: 'logs', label: 'Logs' },
      { value: 'disable', label: 'Disable' },
    ],
  }));

  switch (choice) {
    case 'status':
      await showScheduleStatus();
      break;
    case 'enable':
      await enableSchedule();
      break;
    case 'run':
      await runScheduleNow();
      break;
    case 'logs':
      await showScheduleLogs();
      break;
    case 'disable':
      await disableSchedule();
      break;
  }
}

async function syncMenu(): Promise<void> {
  const choice = required(await prompts.select({
    message: 'Local mirror',
    options: [
      { value: 'state', label: 'Status', hint: 'last sync and sizes per account' },
      { value: 'select', label: 'Sync', hint: 'choose which accounts' },
      { value: 'all', label: 'Sync everything' },
    ],
  }));

  switch (choice) {
    case 'state':
      await showSyncState();
      break;
    case 'select':
      await syncFlow();
      break;
    case 'all':
      await runSyncWithFeedback();
      break;
  }
}

/**
 * Main menu. It loops until you exit, so a maintenance session does not force you to relaunch the
 * command for every operation.
 */
export async function interactiveMenu(): Promise<void> {
  // Same reasoning as `framed`: kicked off before the menu, reported on the way out.
  const updateCheck = startUpdateCheck();

  renderIntro();

  let running = true;

  while (running) {
    const area = required(await prompts.select({
      message: 'What are we doing?',
      options: [
        { value: 'accounts', label: 'Accounts', hint: 'list, add, edit, remove, test' },
        { value: 'sync', label: 'Local mirror', hint: 'status and syncing' },
        { value: 'schedule', label: 'Scheduled sync', hint: 'periodic background runs' },
        { value: 'exit', label: 'Exit' },
      ],
    }));

    if (area === 'exit') {
      running = false;
      break;
    }

    if (area === 'accounts') {
      await accountMenu();
    } else if (area === 'sync') {
      await syncMenu();
    } else {
      await scheduleMenu();
    }
  }

  const notice = await updateCheck.collect();

  if (notice !== undefined) {
    prompts.log.info(notice);
  }

  prompts.outro('Done.');
}
