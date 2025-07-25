/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename } from '../../../../base/common/resources.js';
import { Mutable } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { DidUninstallMcpServerEvent, IGalleryMcpServer, IMcpGalleryService, InstallMcpServerResult, IQueryOptions, IInstallableMcpServer, IMcpServerManifest, ILocalMcpServer } from '../../../../platform/mcp/common/mcpManagement.js';
import { IMcpServerConfiguration, IMcpServerVariable, IMcpStdioServerConfiguration, McpServerType } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { StorageScope } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IURLService } from '../../../../platform/url/common/url.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { MCP_CONFIGURATION_KEY, WORKSPACE_STANDALONE_CONFIGURATIONS } from '../../../services/configuration/common/configuration.js';
import { ACTIVE_GROUP, IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IWorkbenchLocalMcpServer, IWorkbenchMcpManagementService, LocalMcpServerScope } from '../../../services/mcp/common/mcpWorkbenchManagementService.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';
import { mcpConfigurationSection } from '../common/mcpConfiguration.js';
import { HasInstalledMcpServersContext, IMcpConfigPath, IMcpWorkbenchService, IWorkbenchMcpServer, McpCollectionSortOrder, McpServersGalleryEnabledContext } from '../common/mcpTypes.js';
import { McpServerEditorInput } from './mcpServerEditorInput.js';

class McpWorkbenchServer implements IWorkbenchMcpServer {

	constructor(
		public local: IWorkbenchLocalMcpServer | undefined,
		public gallery: IGalleryMcpServer | undefined,
		public readonly installable: IInstallableMcpServer | undefined,
		@IMcpGalleryService private readonly mcpGalleryService: IMcpGalleryService,
		@IFileService private readonly fileService: IFileService,
	) {
		this.local = local;
	}

	get id(): string {
		return this.gallery?.id ?? this.local?.id ?? this.installable?.name ?? '';
	}

	get name(): string {
		return this.gallery?.name ?? this.local?.name ?? this.installable?.name ?? '';
	}

	get label(): string {
		return this.gallery?.displayName ?? this.local?.displayName ?? this.local?.name ?? this.installable?.name ?? '';
	}

	get icon(): {
		readonly dark: string;
		readonly light: string;
	} | undefined {
		return this.gallery?.icon ?? this.local?.icon;
	}

	get codicon(): string | undefined {
		return this.gallery?.codicon ?? this.local?.codicon;
	}

	get publisherDisplayName(): string | undefined {
		return this.gallery?.publisherDisplayName ?? this.local?.publisherDisplayName ?? this.gallery?.publisher ?? this.local?.publisher;
	}

	get publisherUrl(): string | undefined {
		return this.gallery?.publisherDomain?.link;
	}

	get description(): string {
		return this.gallery?.description ?? this.local?.description ?? '';
	}

	get installCount(): number {
		return this.gallery?.installCount ?? 0;
	}

	get url(): string | undefined {
		return this.gallery?.url;
	}

	get repository(): string | undefined {
		return this.gallery?.repositoryUrl;
	}

	get config(): IMcpServerConfiguration | undefined {
		return this.local?.config ?? this.installable?.config;
	}

	get readmeUrl(): URI | undefined {
		return this.local?.readmeUrl ?? (this.gallery?.readmeUrl ? URI.parse(this.gallery.readmeUrl) : undefined);
	}

	async getReadme(token: CancellationToken): Promise<string> {
		if (this.local?.readmeUrl) {
			const content = await this.fileService.readFile(this.local.readmeUrl);
			return content.value.toString();
		}

		if (this.gallery?.readmeUrl) {
			return this.mcpGalleryService.getReadme(this.gallery, token);
		}

		return Promise.reject(new Error('not available'));
	}

	async getManifest(token: CancellationToken): Promise<IMcpServerManifest> {
		if (this.local?.manifest) {
			return this.local.manifest;
		}

		if (this.gallery) {
			return this.mcpGalleryService.getManifest(this.gallery, token);
		}

		throw new Error('No manifest available');
	}

}

export class McpWorkbenchService extends Disposable implements IMcpWorkbenchService {

	_serviceBrand: undefined;

	private _local: McpWorkbenchServer[] = [];
	get local(): readonly McpWorkbenchServer[] { return this._local; }

	private readonly _onChange = this._register(new Emitter<IWorkbenchMcpServer | undefined>());
	readonly onChange = this._onChange.event;

	constructor(
		@IMcpGalleryService private readonly mcpGalleryService: IMcpGalleryService,
		@IWorkbenchMcpManagementService private readonly mcpManagementService: IWorkbenchMcpManagementService,
		@IEditorService private readonly editorService: IEditorService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ILabelService private readonly labelService: ILabelService,
		@IProductService private readonly productService: IProductService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IURLService urlService: IURLService,
	) {
		super();
		this._register(this.mcpManagementService.onDidInstallMcpServersInCurrentProfile(e => this.onDidInstallMcpServers(e)));
		this._register(this.mcpManagementService.onDidUpdateMcpServersInCurrentProfile(e => this.onDidUpdateMcpServers(e)));
		this._register(this.mcpManagementService.onDidUninstallMcpServerInCurrentProfile(e => this.onDidUninstallMcpServer(e)));
		this.queryLocal().then(() => this.syncInstalledMcpServers());
		urlService.registerHandler(this);
	}

	private onDidUninstallMcpServer(e: DidUninstallMcpServerEvent) {
		if (e.error) {
			return;
		}
		const server = this._local.find(server => server.local?.name === e.name);
		if (server) {
			this._local = this._local.filter(server => server.local?.name !== e.name);
			server.local = undefined;
			this._onChange.fire(server);
		}
	}

	private onDidInstallMcpServers(e: readonly InstallMcpServerResult[]) {
		const servers: IWorkbenchMcpServer[] = [];
		for (const result of e) {
			if (!result.local) {
				continue;
			}
			servers.push(this.onDidInstallMcpServer(result.local, result.source));
		}
		if (servers.some(server => server.local?.source === 'gallery' && !server.gallery)) {
			this.syncInstalledMcpServers();
		}
	}

	private onDidInstallMcpServer(local: IWorkbenchLocalMcpServer, gallery?: IGalleryMcpServer): IWorkbenchMcpServer {
		let server = this._local.find(server => server.local?.name === local.name);
		if (server) {
			server.local = local;
		} else {
			server = this.instantiationService.createInstance(McpWorkbenchServer, local, gallery, undefined);
			this._local.push(server);
		}
		this._onChange.fire(server);
		return server;
	}

	private onDidUpdateMcpServers(e: readonly InstallMcpServerResult[]) {
		for (const result of e) {
			if (!result.local) {
				continue;
			}
			const serverIndex = this._local.findIndex(server => server.local?.name === result.name);
			let server: McpWorkbenchServer;
			if (serverIndex !== -1) {
				this._local[serverIndex].local = result.local;
				server = this._local[serverIndex];
			} else {
				server = this.instantiationService.createInstance(McpWorkbenchServer, result.local, result.source, undefined);
				this._local.push(server);
			}
			this._onChange.fire(server);
		}
	}

	private fromGallery(gallery: IGalleryMcpServer): IWorkbenchMcpServer | undefined {
		for (const local of this._local) {
			if (local.name === gallery.name) {
				local.gallery = gallery;
				return local;
			}
		}
		return undefined;
	}

	private async syncInstalledMcpServers(): Promise<void> {
		const installedGalleryServers: ILocalMcpServer[] = [];
		for (const installed of this.local) {
			if (installed.local?.source !== 'gallery') {
				continue;
			}
			installedGalleryServers.push(installed.local);
		}
		if (installedGalleryServers.length) {
			const galleryServers = await this.mcpGalleryService.getMcpServers(installedGalleryServers.map(server => server.name));
			if (galleryServers.length) {
				this.syncInstalledMcpServersWithGallery(galleryServers);
			}
		}
	}

	private async syncInstalledMcpServersWithGallery(gallery: IGalleryMcpServer[]): Promise<void> {
		const galleryMap = new Map<string, IGalleryMcpServer>(gallery.map(server => [server.name, server]));
		for (const mcpServer of this.local) {
			if (!mcpServer.gallery) {
				if (!mcpServer.local) {
					continue;
				}
				if (mcpServer.gallery) {
					continue;
				}
				const galleryServer = galleryMap.get(mcpServer.name);
				if (!galleryServer) {
					continue;
				}
				mcpServer.gallery = galleryServer;
				if (!mcpServer.id) {
					mcpServer.local = await this.mcpManagementService.updateMetadata(mcpServer.local, galleryServer);
				}
				this._onChange.fire(mcpServer);
			}
		}
	}

	async queryGallery(options?: IQueryOptions, token?: CancellationToken): Promise<IWorkbenchMcpServer[]> {
		if (!this.mcpGalleryService.isEnabled()) {
			return [];
		}
		const result = await this.mcpGalleryService.query(options, token);
		return result.map(gallery => this.fromGallery(gallery) ?? this.instantiationService.createInstance(McpWorkbenchServer, undefined, gallery, undefined));
	}

	async queryLocal(): Promise<IWorkbenchMcpServer[]> {
		const installed = await this.mcpManagementService.getInstalled();
		this._local = installed.map(i => {
			const local = this._local.find(server => server.name === i.name) ?? this.instantiationService.createInstance(McpWorkbenchServer, undefined, undefined, undefined);
			local.local = i;
			return local;
		});
		return this._local;
	}

	async install(server: IWorkbenchMcpServer): Promise<IWorkbenchMcpServer> {
		if (server.installable) {
			const local = await this.mcpManagementService.install(server.installable);
			return this.onDidInstallMcpServer(local);
		}

		if (server.gallery) {
			const local = await this.mcpManagementService.installFromGallery(server.gallery, { packageType: server.gallery.packageTypes[0] });
			return this.onDidInstallMcpServer(local);
		}

		throw new Error('No installable server found');
	}

	async uninstall(server: IWorkbenchMcpServer): Promise<void> {
		if (!server.local) {
			throw new Error('Local server is missing');
		}
		await this.mcpManagementService.uninstall(server.local);
	}

	getMcpConfigPath(localMcpServer: IWorkbenchLocalMcpServer): IMcpConfigPath | undefined;
	getMcpConfigPath(mcpResource: URI): Promise<IMcpConfigPath | undefined>;
	getMcpConfigPath(arg: URI | IWorkbenchLocalMcpServer): Promise<IMcpConfigPath | undefined> | IMcpConfigPath | undefined {
		if (arg instanceof URI) {
			const mcpResource = arg;
			for (const profile of this.userDataProfilesService.profiles) {
				if (this.uriIdentityService.extUri.isEqual(profile.mcpResource, mcpResource)) {
					return this.getUserMcpConfigPath(mcpResource);
				}
			}

			return this.remoteAgentService.getEnvironment().then(remoteEnvironment => {
				if (remoteEnvironment && this.uriIdentityService.extUri.isEqual(remoteEnvironment.mcpResource, mcpResource)) {
					return this.getRemoteMcpConfigPath(mcpResource);
				}
				return this.getWorkspaceMcpConfigPath(mcpResource);
			});
		}

		if (arg.scope === LocalMcpServerScope.User) {
			return this.getUserMcpConfigPath(arg.mcpResource);
		}

		if (arg.scope === LocalMcpServerScope.Workspace) {
			return this.getWorkspaceMcpConfigPath(arg.mcpResource);
		}

		if (arg.scope === LocalMcpServerScope.RemoteUser) {
			return this.getRemoteMcpConfigPath(arg.mcpResource);
		}

		return undefined;
	}

	private getUserMcpConfigPath(mcpResource: URI): IMcpConfigPath {
		return {
			id: 'usrlocal',
			key: 'userLocalValue',
			target: ConfigurationTarget.USER_LOCAL,
			label: localize('mcp.configuration.userLocalValue', 'Global in {0}', this.productService.nameShort),
			scope: StorageScope.PROFILE,
			order: McpCollectionSortOrder.User,
			uri: mcpResource,
			section: [],
		};
	}

	private getRemoteMcpConfigPath(mcpResource: URI): IMcpConfigPath {
		return {
			id: 'usrremote',
			key: 'userRemoteValue',
			target: ConfigurationTarget.USER_REMOTE,
			label: this.environmentService.remoteAuthority ? this.labelService.getHostLabel(Schemas.vscodeRemote, this.environmentService.remoteAuthority) : 'Remote',
			scope: StorageScope.PROFILE,
			order: McpCollectionSortOrder.User + McpCollectionSortOrder.RemoteBoost,
			remoteAuthority: this.environmentService.remoteAuthority,
			uri: mcpResource,
			section: [],
		};
	}

	private getWorkspaceMcpConfigPath(mcpResource: URI): IMcpConfigPath | undefined {
		const workspace = this.workspaceService.getWorkspace();
		if (workspace.configuration && this.uriIdentityService.extUri.isEqual(workspace.configuration, mcpResource)) {
			return {
				id: 'workspace',
				key: 'workspaceValue',
				target: ConfigurationTarget.WORKSPACE,
				label: basename(mcpResource),
				scope: StorageScope.WORKSPACE,
				order: McpCollectionSortOrder.Workspace,
				remoteAuthority: this.environmentService.remoteAuthority,
				uri: mcpResource,
				section: ['settings', mcpConfigurationSection],
			};
		}

		const workspaceFolders = workspace.folders;
		for (let index = 0; index < workspaceFolders.length; index++) {
			const workspaceFolder = workspaceFolders[index];
			if (this.uriIdentityService.extUri.isEqual(this.uriIdentityService.extUri.joinPath(workspaceFolder.uri, WORKSPACE_STANDALONE_CONFIGURATIONS[MCP_CONFIGURATION_KEY]), mcpResource)) {
				return {
					id: `wf${index}`,
					key: 'workspaceFolderValue',
					target: ConfigurationTarget.WORKSPACE_FOLDER,
					label: `${workspaceFolder.name}/.vscode/mcp.json`,
					scope: StorageScope.WORKSPACE,
					remoteAuthority: this.environmentService.remoteAuthority,
					order: McpCollectionSortOrder.WorkspaceFolder,
					uri: mcpResource,
					workspaceFolder,
				};
			}
		}

		return undefined;
	}

	async handleURL(uri: URI): Promise<boolean> {
		if (uri.path !== 'mcp/install') {
			return false;
		}

		let parsed: IMcpServerConfiguration & { name: string; inputs?: IMcpServerVariable[]; gallery?: boolean };
		try {
			parsed = JSON.parse(decodeURIComponent(uri.query));
		} catch (e) {
			return false;
		}

		try {
			const { name, inputs, gallery, ...config } = parsed;

			if (gallery || !config || Object.keys(config).length === 0) {
				const [galleryServer] = await this.mcpGalleryService.getMcpServers([name]);
				if (!galleryServer) {
					throw new Error(`MCP server '${name}' not found in gallery`);
				}
				this.open(this.instantiationService.createInstance(McpWorkbenchServer, undefined, galleryServer, undefined));
			} else {
				if (config.type === undefined) {
					(<Mutable<IMcpServerConfiguration>>config).type = (<IMcpStdioServerConfiguration>parsed).command ? McpServerType.LOCAL : McpServerType.REMOTE;
				}
				this.open(this.instantiationService.createInstance(McpWorkbenchServer, undefined, undefined, { name, config, inputs }));
			}
		} catch (e) {
			// ignore
		}
		return true;
	}

	async open(extension: IWorkbenchMcpServer, options?: IEditorOptions): Promise<void> {
		await this.editorService.openEditor(this.instantiationService.createInstance(McpServerEditorInput, extension), options, ACTIVE_GROUP);
	}

}

export class MCPContextsInitialisation extends Disposable implements IWorkbenchContribution {

	static ID = 'workbench.mcp.contexts.initialisation';

	constructor(
		@IMcpWorkbenchService mcpWorkbenchService: IMcpWorkbenchService,
		@IMcpGalleryService mcpGalleryService: IMcpGalleryService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const hasInstalledMcpServersContextKey = HasInstalledMcpServersContext.bindTo(contextKeyService);
		McpServersGalleryEnabledContext.bindTo(contextKeyService).set(mcpGalleryService.isEnabled());
		hasInstalledMcpServersContextKey.set(mcpWorkbenchService.local.length > 0);
		this._register(mcpWorkbenchService.onChange(() => hasInstalledMcpServersContextKey.set(mcpWorkbenchService.local.length > 0)));
	}
}
