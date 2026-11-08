import { fileURLToPath } from 'node:url';

/** 夹具目录（fileURLToPath 正确解码中文路径） */
export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
