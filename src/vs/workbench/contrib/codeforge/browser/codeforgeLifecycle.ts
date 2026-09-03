/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeForge contributors.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import * as nls from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILifecycleService, ShutdownReason } from '../../../services/lifecycle/common/lifecycle.js';

const BUILD_RUNNING = 'codeforge.buildRunning';
const BUILD_STATUS = 'codeforge.buildStatus';
const AI_RUNNING = 'codeforge.aiRunning';
const AI_STATUS = 'codeforge.aiStatus';
const GIT_RUNNING = 'codeforge.gitRunning';
const GIT_STATUS = 'codeforge.gitStatus';

interface ActiveOperation {
	readonly kind: 'build' | 'ai' | 'git';
	readonly label: string;
	readonly status?: string;
}

export class CodeForgeLifecycleContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ILifecycleService lifecycleService: ILifecycleService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IDialogService private readonly dialogService: IDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(lifecycleService.onBeforeShutdown(event => {
			event.veto(this.shouldVetoShutdown(event.reason), 'veto.codeforge.activeOperation');
		}));
	}

	private activeOperations(): ActiveOperation[] {
		const operations: ActiveOperation[] = [];
		if (this.contextKeyService.getContextKeyValue<boolean>(BUILD_RUNNING) === true) {
			operations.push({
				kind: 'build',
				label: nls.localize('codeforge.activeBuild', "Build"),
				status: this.contextKeyService.getContextKeyValue<string>(BUILD_STATUS)
			});
		}
		if (this.contextKeyService.getContextKeyValue<boolean>(AI_RUNNING) === true) {
			operations.push({
				kind: 'ai',
				label: nls.localize('codeforge.activeAI', "AI task"),
				status: this.contextKeyService.getContextKeyValue<string>(AI_STATUS)
			});
		}
		if (this.contextKeyService.getContextKeyValue<boolean>(GIT_RUNNING) === true) {
			operations.push({
				kind: 'git',
				label: nls.localize('codeforge.activeGit', "Git operation"),
				status: this.contextKeyService.getContextKeyValue<string>(GIT_STATUS)
			});
		}
		return operations;
	}

	private async shouldVetoShutdown(reason: ShutdownReason): Promise<boolean> {
		if (this.configurationService.getValue<boolean>('codeforge.shutdown.confirmActiveOperations') === false) {
			return false;
		}

		const operations = this.activeOperations();
		if (operations.length === 0) {
			return false;
		}

		const isApplicationExit = reason === ShutdownReason.CLOSE || reason === ShutdownReason.QUIT;
		const title = isApplicationExit
			? nls.localize('codeforge.shutdownTitle', "CodeForge is still working")
			: nls.localize('codeforge.reloadTitle', "CodeForge has active work");
		const detail = operations
			.map(operation => operation.status ? `${operation.label}: ${operation.status}` : operation.label)
			.join('\n');

		const result = await this.dialogService.prompt<'wait' | 'cancelAndExit' | 'cancelShutdown'>({
			type: 'warning',
			title,
			message: isApplicationExit
				? nls.localize('codeforge.shutdownMessage', "One or more CodeForge operations are still running. Closing now may interrupt them.")
				: nls.localize('codeforge.reloadMessage', "One or more CodeForge operations are still running. Continuing may interrupt them."),
			detail,
			buttons: [
				{
					label: nls.localize({ key: 'codeforge.wait', comment: ['&& denotes a mnemonic'] }, "&&Wait"),
					run: () => 'wait'
				},
				{
					label: isApplicationExit
						? nls.localize({ key: 'codeforge.cancelAndExit', comment: ['&& denotes a mnemonic'] }, "Cancel Operations &&and Exit")
						: nls.localize({ key: 'codeforge.cancelAndContinue', comment: ['&& denotes a mnemonic'] }, "Cancel Operations &&and Continue"),
					run: () => 'cancelAndExit'
				}
			],
			cancelButton: {
				label: isApplicationExit
					? nls.localize('codeforge.cancelShutdown', "Cancel Shutdown")
					: nls.localize('codeforge.cancelReload', "Cancel"),
				run: () => 'cancelShutdown'
			}
		});

		if (result.result === 'cancelAndExit') {
			try {
				await this.commandService.executeCommand('codeforge.cancelActiveOperations');
			} catch {
				// If the extension host is unavailable during shutdown, allow the normal
				// lifecycle to terminate its processes rather than trapping the window.
			}
			return false;
		}

		// Both "Wait" and the cancel button veto this shutdown attempt. The user
		// can close again after the operation finishes or explicitly choose the
		// cancel-and-exit action.
		return true;
	}
}
