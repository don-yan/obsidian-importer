import { App, Notice, Platform, Setting, TFile, TFolder, Plugin, Modal } from 'obsidian';
import { NoteConverter } from './apple-notes/convert-note';
import { ANAccount, ANAttachment, ANConverter, ANConverterType, ANFolderType } from './apple-notes/models';
import { descriptor } from './apple-notes/descriptor';
import { ImportContext, ImporterData, ImporterModal } from '../main';
import { fsPromises, os, path, splitext, zlib } from '../filesystem';
import { sanitizeFileName } from '../util';
import { FormatImporter } from '../format-importer';
import { Root } from 'protobufjs';
import SQLiteTag from './apple-notes/sqlite/index';
import { SQLiteTagSpawned } from './apple-notes/models';

const NOTE_FOLDER_PATH = 'Library/Group Containers/group.com.apple.notes';
const NOTE_DB = 'NoteStore.sqlite';
/** Additional amount of seconds that Apple CoreTime datatypes start at, to convert them into Unix timestamps. */
const CORETIME_OFFSET = 978307200;

// Cache database path per instance (reset per execution)
let cachedDbPath: string | null = null;

export interface AppleNotesSavedData {
	// The metadata we want to cache
	modificationDate: number;
	filePath: string;
}

export class AppleNotesImporter extends FormatImporter {
	ctx: ImportContext;
	rootFolder: TFolder;

	database: SQLiteTagSpawned;
	protobufRoot: Root;

	keys: Record<string, number>;
	owners: Record<number, number> = {};
	resolvedAccounts: Record<number, ANAccount> = {};
	resolvedFiles: Record<number, TFile> = {};
	resolvedFolders: Record<number, TFolder> = {};

	multiAccount = false;
	noteCount = 0;
	parsedNotes = 0;

	omitFirstLine = true;
	importTrashed = false;
	includeHandwriting = false;
	trashFolders: number[] = [];

	accountFilter: string[] = []; // Optional account names to filter
	folderFilter: string[] = []; // Optional folder titles to filter

	addFrontMatter = true;

	// New: Persistent storage for note metadata
	private pluginData: ImporterData;
	private importMetadata: Map<string, AppleNotesSavedData> = new Map();

	constructor(app: App, modal: ImporterModal) {
		super(app, modal);
		// Reset cache for new execution
		cachedDbPath = null;
	}


	init(): void {
		if (!Platform.isMacOS || !Platform.isDesktop) {
			this.modal.contentEl.createEl('p', {
				text:
					'Due to platform limitations, Apple Notes cannot be exported from this device.' +
					' Open your vault on a Mac to export from Apple Notes.'
			});

			this.notAvailable = true;
			return;
		}

		// TODO: changeBack
		this.addOutputLocationSetting('Apple Notes-test');
		// this.addOutputLocationSetting(`Apple Notes - ${new Date().getTime()}`);

		new Setting(this.modal.contentEl)
			.setName('Import recently deleted notes')
			.setDesc(
				'Import notes in the "Recently Deleted" folder. Unlike in Apple Notes' +
				', they will not be automatically removed after a set amount of time.'
			)
			.addToggle(t => t
				.setValue(false)
				.onChange(async v => this.importTrashed = v)
			);

		new Setting(this.modal.contentEl)
			.setName('Omit first line')
			.setDesc(
				'Don\'t include the first line in the text, since Apple Notes uses it' +
				' as the title. It will still be used as the note name.'
			)
			.addToggle(t => t
				.setValue(false) // TODO: toggle back
				.onChange(async v => this.omitFirstLine = v)
			);

		new Setting(this.modal.contentEl)
			.setName('Include handwriting text')
			.setDesc(
				'When Apple Notes has detected handwriting in drawings, include it as text before the drawing.'
			)
			.addToggle(t => t
				.setValue(false)
				.onChange(async v => this.includeHandwriting = v)
			);
		/*

				// Settings for filters
				new Setting(this.modal.contentEl)
					.setName('Accounts to import')
					.setDesc(
						'Comma-separated list of account names to import (case-insensitive, empty for all). ' +
						'Example: iCloud,Local'
					)
					.addText(t => t
						.onChange(async v => this.accountFilter = v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
					);

				new Setting(this.modal.contentEl)
					.setName('Folders to import')
					.setDesc(
						'Comma-separated list of folder titles to import (case-insensitive, empty for all). ' +
						'Example: Work,Personal'
					)
					.addText(t => t
							.onChange(async v => this.folderFilter = v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
						// .setValue('test')
					);

		*/
		// New setting for front matter
		new Setting(this.modal.contentEl)
			.setName('Add YAML front matter')
			.setDesc(
				'Include YAML front matter with tags, dates, and folder in imported notes.'
			)
			.addToggle(t => t
				.onChange(async v => this.addFrontMatter = v)
				.setValue(true) // TODO: toggle back
			);

		// New: Button to load accounts and folders dynamically
		new Setting(this.modal.contentEl)
			.setName('Load Accounts and Folders')
			.setDesc('Click to fetch available accounts and folders from Apple Notes for selection.')
			.addButton(button => button
				.setButtonText('Load')
				.onClick(async () => {
					this.database = await this.getNotesDatabase() as SQLiteTagSpawned;
					if (!this.database) return;

					this.keys = Object.fromEntries(
						(await this.database.all`SELECT z_ent, z_name
												 FROM z_primarykey`).map(k => [k.Z_NAME, k.Z_ENT])
					);

					// Fetch accounts
					const noteAccounts = await this.database.all`
						SELECT z_pk, zname
						FROM ziccloudsyncingobject
						WHERE z_ent = ${this.keys.ICAccount}
					`;

					// Fetch folders (without filter for full list)
					const noteFolders = await this.database.all`
						SELECT z_pk, ztitle2
						FROM ziccloudsyncingobject
						WHERE z_ent = ${this.keys.ICFolder}
					`;

					// Clear previous dynamic settings if any (optional: use a container div)
					const container = this.modal.contentEl.createDiv();

					// Accounts multi-select via toggles
					container.createEl('h3', { text: 'Select Accounts to Import' });
					this.accountFilter = []; // Reset
					noteAccounts.forEach(acc => {
						new Setting(container)
							.setName(acc.ZNAME)
							.addToggle(t => t
								.setValue(false)
								.onChange(v => {
									if (v) this.accountFilter.push(acc.ZNAME.toLowerCase());
									else this.accountFilter = this.accountFilter.filter(a => a !== acc.ZNAME.toLowerCase());
								})
							);
					});

					// Folders multi-select via toggles
					container.createEl('h3', { text: 'Select Folders to Import' });
					this.folderFilter = []; // Reset
					noteFolders.forEach(fol => {
						new Setting(container)
							.setName(fol.ZTITLE2)
							.addToggle(t => t
								.setValue(false)
								.onChange(v => {
									if (v) this.folderFilter.push(fol.ZTITLE2.toLowerCase());
									else this.folderFilter = this.folderFilter.filter(f => f !== fol.ZTITLE2.toLowerCase());
								})
							);
					});

					new Notice('Accounts and folders loaded for selection.');
				})
			);
	}

	async getNotesDatabase(): Promise<SQLiteTagSpawned | null> {
		const dataPath = path.join(os.homedir(), NOTE_FOLDER_PATH);

		// Reuse cached path if available
		if (cachedDbPath) {
			try {
				await fsPromises.access(path.join(cachedDbPath, NOTE_DB));
				await fsPromises.access(path.join(cachedDbPath, NOTE_DB + '-shm'));
				await fsPromises.access(path.join(cachedDbPath, NOTE_DB + '-wal'));

				const clonedDB = path.join(os.tmpdir(), NOTE_DB);
				await this.copyDatabaseFiles(cachedDbPath, clonedDB);

				// @ts-ignore
				return new SQLiteTag(clonedDB, { readonly: true, persistent: true });
			} catch (e) {
				console.warn('Cached database path invalid, prompting for new selection:', e);
				cachedDbPath = null;
			}
		}

		// Prompt for folder selection
		const names = window.electron.remote.dialog.showOpenDialogSync({
			defaultPath: dataPath,
			properties: ['openDirectory'],
			//see https://developer.apple.com/videos/play/wwdc2019/701/
			message: 'Select the "group.com.apple.notes" folder to allow Obsidian to read Apple Notes data.'
		});

		if (!names?.includes(dataPath)) {
			new Notice('Data import failed. Ensure you have selected the correct Apple Notes data folder.');
			return null;
		}

		// Cache the selected path
		cachedDbPath = dataPath;

		const originalDB = path.join(dataPath, NOTE_DB);
		const clonedDB = path.join(os.tmpdir(), NOTE_DB);

		await this.copyDatabaseFiles(dataPath, clonedDB);

		//@ts-ignore
		return new SQLiteTag(clonedDB, { readonly: true, persistent: true });
	}


	async import(ctx: ImportContext): Promise<void> {
		this.ctx = ctx;
		this.protobufRoot = Root.fromJSON(descriptor);
		this.rootFolder = await this.getOutputFolder() as TFolder;

		if (!this.rootFolder) {
			new Notice('Please select a location to export to.');
			return;
		}

		// Load persistent data
		await this.loadPluginData();

		// @ts-ignore
		this.database = await this.getNotesDatabase() as SQLiteTagSpawned;
		if (!this.database) return;

		this.keys = Object.fromEntries(
			(await this.database.all`SELECT z_ent, z_name
									 FROM z_primarykey`).map(k => [k.Z_NAME, k.Z_ENT])
		);


		// Fetch all accounts, then filter if specified
		let noteAccounts = await this.database.all`
			SELECT z_pk, zname
			FROM ziccloudsyncingobject
			WHERE z_ent = ${this.keys.ICAccount}
		`;

		if (this.accountFilter.length > 0) {
			noteAccounts = noteAccounts.filter(a => this.accountFilter.includes(a.ZNAME.toLowerCase()));
		}

		const filteredAccountPks = noteAccounts.map(a => a.Z_PK);

		// Fetch and filter folders
		let noteFolders;
		if (filteredAccountPks.length > 0) {
			noteFolders = await this.database.all`
				SELECT z_pk, ztitle2, zowner
				FROM ziccloudsyncingobject
				WHERE z_ent = ${this.keys.ICFolder}
				  AND zowner IN (${filteredAccountPks})
			`;
		} else {
			noteFolders = await this.database.all`
				SELECT z_pk, ztitle2, zowner
				FROM ziccloudsyncingobject
				WHERE z_ent = ${this.keys.ICFolder}
			`;
		}
		if (this.folderFilter.length > 0) {
			noteFolders = noteFolders.filter(f => this.folderFilter.includes(f.ZTITLE2.toLowerCase()));
		}

		const filteredFolderPks = noteFolders.map(f => f.Z_PK);


		// Resolve filtered accounts
		for (let a of noteAccounts) await this.resolveAccount(a.Z_PK);

		// Resolve filtered folders
		for (let f of noteFolders) {
			try {
				await this.resolveFolder(f.Z_PK);
			} catch (e) {
				this.ctx.reportFailed(f.ZTITLE2, e?.message);
				console.error(e);
			}
		}

		console.info('Importing from Apple Notes with the following settings:', {
			noteAccounts,
			noteFolders,
			addFrontMatter: this.addFrontMatter
		});

		// Fetch notes only in filtered folders
		let notes;
		if (filteredFolderPks.length > 0) {
			notes = await this.database.all`
				SELECT z_pk,
					   zfolder,
					   ztitle1,
					   zmodificationdate1
				FROM ziccloudsyncingobject
				WHERE z_ent = ${this.keys.ICNote}
				  AND ztitle1 IS NOT NULL
				  AND zfolder NOT IN (${this.trashFolders})
				  AND zfolder IN (${filteredFolderPks})
			`;
		} else {
			notes = await this.database.all`
				SELECT z_pk,
					   zfolder,
					   ztitle1,
					   zmodificationdate1
				FROM ziccloudsyncingobject
				WHERE z_ent = ${this.keys.ICNote}
				  AND ztitle1 IS NOT NULL
				  AND zfolder NOT IN (${this.trashFolders})
			`;
		}

		this.noteCount = notes.length;

		for (let n of notes) {
			// NOTE: break loop
			if (this.ctx.isCancelled()) {
				break;
			}
			try {
				const existingFile = await this.findExistingFileByZpk(n.Z_PK) as TFile;
				const appleModTime = this.decodeTime(n.ZMODIFICATIONDATE1);
				const metadata = this.importMetadata.get(n.Z_PK.toString()) || { modificationDate: 0, filePath: '' };

				if (existingFile) {
					// Check for rename: Compare basename with sanitized ZTITLE1
					if (existingFile.basename !== sanitizeFileName(n.ZTITLE1)) {
						debugger;
						const folder = this.resolvedFolders[n.ZFOLDER] || this.rootFolder;
						const renamedFile = await this.renameFile(existingFile, n.ZTITLE1, folder) as TFile;
						this.resolvedFiles[n.Z_PK] = renamedFile;
						console.log('renaming file', existingFile.path, n.ZTITLE1);
						this.ctx.reportNoteSuccess(`File Renamed: ${existingFile.path} ==> ${renamedFile.path}`);
						this.importMetadata.set(n.Z_PK.toString(), {
							modificationDate: appleModTime,
							filePath: renamedFile.path
						});
					}

					// Case a: Apple modified, Obsidian unchanged
					if (appleModTime > metadata.modificationDate) {
						const content = await this.resolveNote(n.Z_PK, n.ZTITLE1, existingFile);
						if (content) {
							console.log('Apple file modified - Updating', existingFile.path);
						}
					}
					// Case b: Apple unchanged, Obsidian modified
					else if (appleModTime <= metadata.modificationDate && existingFile.stat.mtime > metadata.modificationDate) {
						this.ctx.reportSkipped(n.ZTITLE1, 'Obsidian note modified since last import');
						console.log('Obsidian file modified - Skipping', existingFile.path);
						continue;
					}
					// Case c: Both modified
					else if (appleModTime > metadata.modificationDate && existingFile.stat.mtime > metadata.modificationDate) {
						const backupPath = `${existingFile.path.replace(/\.md$/, '')}-backup-${Date.now()}.md`;
						await this.vault.copy(existingFile, backupPath);
						console.log('Conflict found - creating backup', backupPath);
						this.ctx.reportNoteSuccess(`Backup created: ${backupPath}`);
						const content = await this.resolveNote(n.Z_PK, n.ZTITLE1, existingFile);
					}
					// Unchanged
					else {
						this.ctx.reportSkipped(n.ZTITLE1, 'No changes detected');
						console.log('Skipping file', existingFile.path);
						continue;
					}
				} else {
					// New note
					const content = await this.resolveNote(n.Z_PK, n.ZTITLE1);
					console.info('Creating note', n.ZTITLE1);
				}
			} catch (e) {
				this.ctx.reportFailed(n.ZTITLE1, e?.message);
				console.error(e);
			}
		}

		// Save metadata
		await this.savePluginData();

		this.closeDatabase();
	}

	async resolveAccount(id: number): Promise<void> {
		if (!this.multiAccount && Object.keys(this.resolvedAccounts).length) {
			this.multiAccount = true;
		}

		const account = await this.database.get`
			SELECT zname, zidentifier
			FROM ziccloudsyncingobject
			WHERE z_ent = ${this.keys.ICAccount}
			  AND z_pk = ${id}
		`;

		this.resolvedAccounts[id] = {
			name: account.ZNAME,
			uuid: account.ZIDENTIFIER,
			path: path.join(os.homedir(), NOTE_FOLDER_PATH, 'Accounts', account.ZIDENTIFIER)
		};
	}

	async resolveFolder(id: number): Promise<TFolder | null> {
		if (id in this.resolvedFolders) return this.resolvedFolders[id];

		const folder = await this.database.get`
			SELECT ztitle2, zparent, zidentifier, zfoldertype, zowner
			FROM ziccloudsyncingobject
			WHERE z_ent = ${this.keys.ICFolder}
			  AND z_pk = ${id}
		`;
		let prefix;

		if (folder.ZFOLDERTYPE == ANFolderType.Smart) {
			return null;
		} else if (!this.importTrashed && folder.ZFOLDERTYPE == ANFolderType.Trash) {
			this.trashFolders.push(id);
			return null;
		} else if (folder.ZPARENT !== null) {
			prefix = (await this.resolveFolder(folder.ZPARENT))?.path + '/';
		} else if (this.multiAccount) {
			// If there's a parent, the account root is already handled by that
			const account = this.resolvedAccounts[folder.ZOWNER].name;
			prefix = `${this.rootFolder.path}/${account}/`;
		} else {
			prefix = `${this.rootFolder.path}/`;
		}

		if (!folder.ZIDENTIFIER.startsWith('DefaultFolder')) {
			// Notes in the default "Notes" folder are placed in the main directory
			prefix += sanitizeFileName(folder.ZTITLE2);
		}

		const resolved = await this.createFolders(prefix);
		this.resolvedFolders[id] = resolved;
		this.owners[id] = folder.ZOWNER;

		return resolved;
	}

	/**
	 * Resolves a single note from Apple Notes and saves it to Obsidian.
	 * @param id The note's primary key.
	 * @param title Optional title override.
	 * @param existingFile Optional existing file to update.
	 * @returns {Promise<string | null>} The formatted note content or null if failed.
	 */
	async resolveNote(id: number, title?: string, existingFile?: TFile): Promise<string | null> {
		if (id in this.resolvedFiles) return this.resolvedFiles[id].path;

		const row = await this.database.get`
			SELECT nd.z_pk       as zpk,
				   hex(nd.zdata) as zhexdata,
				   zcso.ztitle1,
				   zfolder,
				   zcreationdate1,
				   zcreationdate2,
				   zcreationdate3,
				   zmodificationdate1,
				   zispasswordprotected
			FROM zicnotedata AS nd,
				 (SELECT *,
						 NULL AS zcreationdate3,
						 NULL AS zcreationdate2,
						 NULL AS zispasswordprotected
				  FROM ziccloudsyncingobject) AS zcso
			WHERE zcso.z_pk = nd.znote
			  AND zcso.z_pk = ${id}
		`;

		if (row.ZISPASSWORDPROTECTED) {
			this.ctx.reportSkipped(row.ZTITLE1, 'note is password protected');
			return null;
		}

		const folder = this.resolvedFolders[row.ZFOLDER] || this.rootFolder;
		const noteTitle = title || row.ZTITLE1;
		const file = existingFile || await this.saveAsMarkdownFile(folder, `${sanitizeFileName(noteTitle)}.md`, '');

		this.ctx.status(`Importing note ${noteTitle}`);
		this.resolvedFiles[id] = file;
		this.owners[id] = this.owners[row.ZFOLDER];

		// Notes may reference other notes, so we want them in resolvedFiles before we parse to avoid cycles
		const converter = this.decodeData(row.zhexdata, NoteConverter, id);

		let content: string | null = null;
		try {
			content = await converter.format(false, file.path);
			await this.vault.modify(file, content, {
				ctime: this.decodeTime(row.ZCREATIONDATE3 || row.ZCREATIONDATE2 || row.ZCREATIONDATE1),
				mtime: this.decodeTime(row.ZMODIFICATIONDATE1)
			});
			// Update noteMetadata with modificationDate and filePath
			this.importMetadata.set(id.toString(), {
				modificationDate: this.decodeTime(row.ZMODIFICATIONDATE1),
				filePath: file.path
			});
		} catch (e) {
			this.ctx.reportFailed(noteTitle, e?.message);
			console.error(e);
		}

		this.parsedNotes++;
		this.ctx.reportProgress(this.parsedNotes, this.noteCount);
		return content;
	}

	async resolveAttachment(id: number, uti: ANAttachment | string): Promise<TFile | null> {
		if (id in this.resolvedFiles) return this.resolvedFiles[id];

		let sourcePath, outName, outExt, row, file;
		try {
			switch (uti) {
				case ANAttachment.ModifiedScan:
					// A PDF only seems to be generated when you modify the scan :(
					row = await this.database.get`
						SELECT zidentifier,
							   zfallbackpdfgeneration,
							   zcreationdate,
							   zmodificationdate,
							   znote
						FROM (SELECT *, NULL AS zfallbackpdfgeneration FROM ziccloudsyncingobject)
						WHERE z_ent = ${this.keys.ICAttachment}
						  AND z_pk = ${id}
					`;

					sourcePath = path.join('FallbackPDFs', row.ZIDENTIFIER, row.ZFALLBACKPDFGENERATION || '', 'FallbackPDF.pdf');
					outName = 'Scan';
					outExt = 'pdf';
					break;

				case ANAttachment.Scan:
					row = await this.database.get`
						SELECT zidentifier,
							   zsizeheight,
							   zsizewidth,
							   zcreationdate,
							   zmodificationdate,
							   znote
						FROM ziccloudsyncingobject
						WHERE z_ent = ${this.keys.ICAttachment}
						  AND z_pk = ${id}
					`;

					sourcePath = path.join('Previews', `${row.ZIDENTIFIER}-1-${row.ZSIZEWIDTH}x${row.ZSIZEHEIGHT}-0.jpeg`);
					outName = 'Scan Page';
					outExt = 'jpg';
					break;

				case ANAttachment.Drawing:
					row = await this.database.get`
						SELECT zidentifier,
							   zfallbackimagegeneration,
							   zcreationdate,
							   zmodificationdate,
							   znote,
							   zhandwritingsummary
						FROM (SELECT *, NULL AS zfallbackimagegeneration FROM ziccloudsyncingobject)
						WHERE z_ent = ${this.keys.ICAttachment}
						  AND z_pk = ${id}
					`;

					if (row.ZFALLBACKIMAGEGENERATION) {
						// macOS 14/iOS 17 and above
						sourcePath = path.join('FallbackImages', row.ZIDENTIFIER, row.ZFALLBACKIMAGEGENERATION, 'FallbackImage.png');
					} else {
						sourcePath = path.join('FallbackImages', `${row.ZIDENTIFIER}.jpg`);
					}

					outName = 'Drawing';
					outExt = 'png';
					break;

				default:
					row = await this.database.get`
						SELECT a.zidentifier,
							   a.zfilename,
							   a.zgeneration1,
							   b.zcreationdate,
							   b.zmodificationdate,
							   b.znote
						FROM (SELECT *, NULL AS zgeneration1 FROM ziccloudsyncingobject) AS a,
							 ziccloudsyncingobject AS b
						WHERE a.z_ent = ${this.keys.ICMedia}
						  AND a.z_pk = ${id}
						  AND a.z_pk = b.zmedia
					`;

					sourcePath = path.join('Media', row.ZIDENTIFIER, row.ZGENERATION1 || '', row.ZFILENAME);
					[outName, outExt] = splitext(row.ZFILENAME);
					break;
			}
		} catch (e) {
			this.ctx.reportFailed(uti);
			console.error(e);
			return null;
		}
		try {

			const binary = await this.getAttachmentSource(this.resolvedAccounts[this.owners[row.ZNOTE]], sourcePath);
			const attachmentPath = await this.getAvailablePathForAttachment(`${outName}.${outExt}`, []);

			file = await this.vault.createBinary(
				attachmentPath, binary,
				{ ctime: this.decodeTime(row.ZCREATIONDATE), mtime: this.decodeTime(row.ZMODIFICATIONDATE) }
			);
		} catch (e) {
			this.ctx.reportFailed(sourcePath);
			console.error(e);
			return null;
		}

		this.resolvedFiles[id] = file;
		this.ctx.reportAttachmentSuccess(this.resolvedFiles[id].path);
		return file;
	}

	decodeData<T extends ANConverter>(hexdata: string, converterType: ANConverterType<T>, noteId?: number) {
		const unzipped = zlib.gunzipSync(Buffer.from(hexdata, 'hex'));
		const decoded = this.protobufRoot.lookupType(converterType.protobufType).decode(unzipped);
		if (noteId) {
			return new converterType(this, decoded, noteId);
		} else {
			return new converterType(this, decoded);
		}

	}

	decodeTime(timestamp: number): number {
		if (!timestamp || timestamp < 1) return new Date().getTime();
		return Math.floor((timestamp + CORETIME_OFFSET) * 1000);
	}

	async getAttachmentSource(account: ANAccount, sourcePath: string): Promise<Buffer> {
		try {
			return await fsPromises.readFile(path.join(account.path, sourcePath));
		} catch (e) {
			return await fsPromises.readFile(path.join(os.homedir(), NOTE_FOLDER_PATH, sourcePath));
		}
	}

	/**
	 * Load note metadata from plugin storage.
	 * @returns {Promise<void>} Resolves when metadata is loaded.
	 */
	private async loadPluginData(): Promise<void> {
		this.pluginData = await this.modal.plugin.loadData() as ImporterData;

		if (this.pluginData?.importers?.apple?.importMetadata) {
			this.importMetadata = new Map(
				Object.entries(this.pluginData.importers.apple.importMetadata)
			);
		} else {
			this.importMetadata = new Map();
		}
	}

	/**
	 * Save note metadata to plugin storage.
	 * @returns {Promise<void>} Resolves when metadata is saved.
	 */
	private async savePluginData(): Promise<void> {
		// Ensure importers.apple exists
		if (!this.pluginData.importers.apple) {
			this.pluginData.importers.apple = { importMetadata: {} };
		}

		// Update importMetadata from Map → Record
		this.pluginData.importers.apple.importMetadata = Object.fromEntries(this.importMetadata);

		await this.modal.plugin.saveData(this.pluginData);
	}

	/**
	 * Find an existing file by z_pk in metadata or frontmatter.
	 * @param z_pk The primary key of the note.
	 * @returns {Promise<TFile | null>} The matching file or null.
	 */
	private async findExistingFileByZpk(z_pk: number): Promise<TFile | null> {
		const metadata = this.importMetadata.get(z_pk.toString());
		if (metadata?.filePath) {
			const file = this.vault.getAbstractFileByPath(metadata.filePath);
			if (file instanceof TFile) {
				return file;
			}
		}
		// Fallback to scanning resolvedFiles if metadata is missing or path is invalid
		for (const file of Object.values(this.resolvedFiles)) {
			const frontmatter = await this.readFrontmatter(file);
			if (frontmatter?.z_pk?.toString() === z_pk.toString()) {
				// Update metadata with correct path if found
				this.importMetadata.set(z_pk.toString(), {
					modificationDate: metadata?.modificationDate || 0,
					filePath: file.path
				});
				return file;
			}
		}
		return null;
	}

	/**
	 * Read frontmatter from a file.
	 * @param file The file to read.
	 * @returns {Promise<Record<string, any> | null>} The frontmatter or null if not found.
	 */
	private async readFrontmatter(file: TFile): Promise<Record<string, any> | null> {
		try {
			const content = await this.vault.read(file);
			const match = content.match(/^---\n([\s\S]*?)\n---\n/);
			if (!match) return null;
			const yaml = require('js-yaml').load(match[1]);
			return yaml as Record<string, any>;
		} catch (e) {
			console.warn(`Failed to read frontmatter for ${file.path}:`, e);
			return null;
		}
	}

	/**
	 * Rename an existing file to match new title.
	 * @param file The file to rename.
	 * @param newTitle The new title.
	 * @param folder The target folder.
	 * @returns {Promise<TFile>} The renamed file.
	 */
	private async renameFile(file: TFile, newTitle: string, folder: TFolder): Promise<TFile> {
		const newPath = `${folder.path}/${sanitizeFileName(newTitle)}.md`;
		if (newPath !== file.path) {
			await this.vault.rename(file, newPath);
			// Trigger cache refresh to update links
			this.app.metadataCache.trigger('resolve');
			return this.vault.getAbstractFileByPath(newPath) as TFile;
		}
		return file;
	}

	/**
	 * Copy database files to destination.
	 * @param sourcePath The source directory.
	 * @param destPath The destination path for the database.
	 * @returns {Promise<void>} Resolves when files are copied.
	 */
	private async copyDatabaseFiles(sourcePath: string, destPath: string): Promise<void> {
		await fsPromises.copyFile(path.join(sourcePath, NOTE_DB), destPath);
		await fsPromises.copyFile(path.join(sourcePath, NOTE_DB + '-shm'), destPath + '-shm');
		await fsPromises.copyFile(path.join(sourcePath, NOTE_DB + '-wal'), destPath + '-wal');
	}

	/**
	 * Cleanup Database files
	 * @private
	 */
	private closeDatabase(): void {
		// Close database at end of import
		if (this.database) {
			this.database.close();
			// @ts-ignore
			this.database = null;
			cachedDbPath = null; // Reset for next execution
		}
	}

	/**
	 * Cleanup the importer
	 *
	 * TODO: is this necessary ?
	 */
	async cleanup(): Promise<void> {
		console.info('Cleanup apple-notes');
		this.closeDatabase();
	}
}
