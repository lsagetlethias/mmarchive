import type { BlockCache } from "./block-cache.js";

/* Codes de retour et constantes SQLite utilises ici. */
const SQLITE_OK = 0;
const SQLITE_IOERR_SHORT_READ = 522;
const SQLITE_READONLY = 8;
const SQLITE_CANTOPEN = 14;
const SQLITE_NOTFOUND = 12;
const SQLITE_OPEN_READONLY = 0x0000_0001;
/** Le fichier ne change jamais : SQLite se dispense alors de verrous. */
const SQLITE_IOCAP_IMMUTABLE = 0x0000_2000;

/**
 * Sqlite3 tel qu expose par le paquet officiel. Le typage publie decrit surtout
 * l API objet ; la couche VFS passe par capi et wasm, dont la forme n est pas
 * typee. On la decrit ici au strict necessaire plutot que de repandre des
 * assertions dans le code.
 */
export interface SqliteWasm {
  capi: {
    sqlite3_vfs: new () => VfsStruct;
    sqlite3_io_methods: new () => IoStruct;
    sqlite3_file: { structInfo: { sizeof: number } };
    sqlite3_vfs_find(name: string | null): number;
  };
  wasm: {
    heap8u(): Uint8Array;
    poke(pointer: number, value: number, type: string): unknown;
    cstrToJs(pointer: number): string | null;
    allocCString(value: string): number;
    cstrncpy(dest: number, src: number, n: number): number;
  };
  vfs: {
    installVfs(options: {
      io: { struct: IoStruct; methods: Record<string, unknown> };
      vfs: {
        struct: VfsStruct;
        methods: Record<string, unknown>;
        name?: string;
        asDefault?: boolean;
      };
    }): unknown;
  };
  oo1: {
    DB: new (options: { filename: string; flags: string; vfs: string }) => SqliteDb;
  };
}

interface VfsStruct {
  $iVersion: number;
  $szOsFile: number;
  $mxPathname: number;
  $zName: number;
  pointer: number;
  addOnDispose(pointer: number): void;
  registerVfs(asDefault: boolean): void;
  installMethods(methods: Record<string, unknown>, applyArgcCheck: boolean): void;
}

interface IoStruct {
  pointer: number;
  installMethods(methods: Record<string, unknown>, applyArgcCheck: boolean): void;
}

export interface SqliteDb {
  exec(options: {
    sql: string;
    bind?: readonly (string | number | null)[];
    rowMode?: string;
    resultRows?: unknown[];
    callback?: (row: unknown) => void;
  }): unknown;
  close(): void;
}

export const LITE_VFS_NAME = "mmarchive-lecture";

/**
 * Installe un VFS de lecture seule adosse a un cache de blocs.
 *
 * Tout ce qui ecrit repond SQLITE_READONLY, et le fichier est annonce immuable :
 * SQLite renonce alors aux verrous, au journal et aux relectures de controle,
 * ce qui est exactement ce que l on veut d une archive figee. Sans cette
 * annonce, la moindre transaction chercherait a creer un journal a cote d un
 * fichier qui n existe que derriere des requetes HTTP.
 */
export function installReadOnlyVfs(
  sqlite3: SqliteWasm,
  source: () => BlockCache | undefined,
): void {
  const { capi, wasm } = sqlite3;
  const vfsStruct = new capi.sqlite3_vfs();
  const ioStruct = new capi.sqlite3_io_methods();

  vfsStruct.$iVersion = 2;
  vfsStruct.$szOsFile = capi.sqlite3_file.structInfo.sizeof;
  vfsStruct.$mxPathname = 512;

  const ioMethods = {
    xClose: () => SQLITE_OK,

    xRead: (_file: number, pDest: number, amount: number, offset: bigint | number): number => {
      const cache = source();
      if (cache === undefined) return SQLITE_CANTOPEN;
      const bytes = cache.read(Number(offset), amount);
      wasm.heap8u().set(bytes, pDest);
      if (bytes.length === amount) return SQLITE_OK;
      // Lecture courte : SQLite exige que le reste soit mis a zero, et attend
      // ce code precis plutot qu une erreur generique.
      wasm.heap8u().fill(0, pDest + bytes.length, pDest + amount);
      return SQLITE_IOERR_SHORT_READ;
    },

    xWrite: () => SQLITE_READONLY,
    xTruncate: () => SQLITE_READONLY,
    xSync: () => SQLITE_OK,

    xFileSize: (_file: number, pSize: number): number => {
      const cache = source();
      if (cache === undefined) return SQLITE_CANTOPEN;
      wasm.poke(pSize, cache.size, "i64");
      return SQLITE_OK;
    },

    // Aucun verrou n a de sens sur une archive que personne ne peut modifier.
    xLock: () => SQLITE_OK,
    xUnlock: () => SQLITE_OK,
    xCheckReservedLock: (_file: number, pOut: number): number => {
      wasm.poke(pOut, 0, "i32");
      return SQLITE_OK;
    },
    xFileControl: () => SQLITE_NOTFOUND,
    xSectorSize: () => 4096,
    xDeviceCharacteristics: () => SQLITE_IOCAP_IMMUTABLE,
  };

  const vfsMethods = {
    xOpen: (
      _vfs: number,
      _name: number,
      pFile: number,
      _flags: number,
      pOutFlags: number,
    ): number => {
      if (source() === undefined) return SQLITE_CANTOPEN;
      // Le seul fichier que ce VFS sait ouvrir est l index deja charge : il n y
      // a ni chemin a resoudre ni fichier annexe possible.
      wasm.poke(pFile, ioStruct.pointer, "i32");
      wasm.poke(pOutFlags, SQLITE_OPEN_READONLY, "i32");
      return SQLITE_OK;
    },

    xDelete: () => SQLITE_READONLY,

    xAccess: (_vfs: number, _name: number, _flags: number, pOut: number): number => {
      // Repondre "absent" a tout : c est ce qui dissuade SQLite de chercher un
      // journal ou un fichier de reprise a cote de l index.
      wasm.poke(pOut, 0, "i32");
      return SQLITE_OK;
    },

    xFullPathname: (_vfs: number, zName: number, nOut: number, pOut: number): number => {
      wasm.cstrncpy(pOut, zName, nOut);
      return SQLITE_OK;
    },

    xGetLastError: (_vfs: number, _nOut: number, _pOut: number) => SQLITE_OK,
    xRandomness: (_vfs: number, n: number, pOut: number): number => {
      const heap = wasm.heap8u();
      for (let i = 0; i < n; i += 1) heap[pOut + i] = 0;
      return n;
    },
    xSleep: () => SQLITE_OK,
    xCurrentTime: (_vfs: number, pOut: number): number => {
      wasm.poke(pOut, 2440587.5, "double");
      return SQLITE_OK;
    },
    xCurrentTimeInt64: (_vfs: number, pOut: number): number => {
      wasm.poke(pOut, 0, "i64");
      return SQLITE_OK;
    },
  };

  ioStruct.installMethods(ioMethods, false);
  vfsStruct.installMethods(vfsMethods, false);
  // Le nom est alloue cote WebAssembly : il doit survivre a l enregistrement, et
  // etre libere avec la structure.
  const namePointer = wasm.allocCString(LITE_VFS_NAME);
  vfsStruct.$zName = namePointer;
  vfsStruct.addOnDispose(namePointer);
  vfsStruct.registerVfs(false);
}
