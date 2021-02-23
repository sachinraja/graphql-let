import { parse } from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { existsSync } from 'fs';
import { stripIgnoredCharacters } from 'graphql';
import makeDir from 'make-dir';
import { dirname, join, join as pathJoin } from 'path';
import slash from 'slash';
import {
  modifyLiteralCalls,
  VisitedCallExpressionResults,
  visitFromProgramPath,
} from '../../ast/ast';
import { processGraphQLCodegenForLiterals } from '../documents';
import { ExecContext } from '../exec-context';
import { readFile, rimraf } from '../file';
import { createHash } from '../hash';
import toSync from '../to-sync';
import { CodegenContext, LiteralCodegenContext } from '../types';
import { PartialCacheStore, TypeCache } from './cache';
import { createPaths, parserOption } from './fns';

// TODO: Move somewhere
// To avoid conflicts of file names
export const typesRootRelDir = 'proj-root';

export async function processLiterals(
  execContext: ExecContext,
  sourceRelPath: string,
  schemaHash: string,
  gqlContents: string[],
  codegenContext: CodegenContext[],
) {
  const cache = new TypeCache(execContext);
  await cache.load();
  const partialCache = cache.get(sourceRelPath);

  const { cwd, config, cacheFullDir } = execContext;
  const dtsRelDir = dirname(config.gqlDtsEntrypoint);

  // const literalCodegenContext: LiteralCodegenContext[] = [];
  const oldGqlHashes = new Set(Object.keys(partialCache));

  // Prepare
  await Promise.all([
    await makeDir(join(cwd, dtsRelDir)),
    await makeDir(cacheFullDir),
  ]);

  for (const gqlContent of gqlContents) {
    const strippedGqlContent = stripIgnoredCharacters(gqlContent);
    const gqlHash = createHash(schemaHash + strippedGqlContent);
    const createdPaths = createPaths(
      pathJoin(typesRootRelDir, sourceRelPath),
      gqlHash,
      dtsRelDir,
      cacheFullDir,
      cwd,
    );
    const context: LiteralCodegenContext = {
      ...createdPaths,
      type: 'literal',
      gqlContent,
      strippedGqlContent,
      gqlHash,
      skip: Boolean(partialCache[gqlHash]),
    };
    codegenContext.push(context);
    // literalCodegenContext.push(context);

    // Note: Non-stripped gqlContent is necessary
    // to write dtsEntrypoint.
    partialCache[gqlHash] = [slash(createdPaths.dtsRelPath), gqlContent];

    // Old caches left will be removed
    oldGqlHashes.delete(gqlHash);
  }

  // Remove old caches
  for (const oldGqlHash of oldGqlHashes) {
    delete partialCache[oldGqlHash];
    const { dtsFullPath } = createPaths(
      sourceRelPath,
      oldGqlHash,
      dtsRelDir,
      cacheFullDir,
      cwd,
    );
    if (existsSync(dtsFullPath)) {
      await rimraf(dtsFullPath);
    }
  }

  await cache.unload();

  return codegenContext;
}

export const processLiteralsSync = toSync(processLiterals);

export async function processLiteralsDeprecated(
  execContext: ExecContext,
  sourceRelPath: string,
  schemaHash: string,
  gqlContents: string[],
  codegenContext: CodegenContext[],
  partialCache: PartialCacheStore,
): Promise<void> {
  const { cwd, config, cacheFullDir } = execContext;
  const dtsRelDir = dirname(config.gqlDtsEntrypoint);

  const literalCodegenContext: LiteralCodegenContext[] = [];
  const oldGqlHashes = new Set(Object.keys(partialCache));

  // Prepare
  await Promise.all([
    await makeDir(join(cwd, dtsRelDir)),
    await makeDir(cacheFullDir),
  ]);

  for (const gqlContent of gqlContents) {
    const strippedGqlContent = stripIgnoredCharacters(gqlContent);
    const gqlHash = createHash(schemaHash + strippedGqlContent);
    const createdPaths = createPaths(
      pathJoin(typesRootRelDir, sourceRelPath),
      gqlHash,
      dtsRelDir,
      cacheFullDir,
      cwd,
    );
    const context: LiteralCodegenContext = {
      ...createdPaths,
      type: 'literal',
      gqlContent,
      strippedGqlContent,
      gqlHash,
      skip: Boolean(partialCache[gqlHash]),
    };
    codegenContext.push(context);
    literalCodegenContext.push(context);

    // Note: Non-stripped gqlContent is necessary
    // to write dtsEntrypoint.
    partialCache[gqlHash] = [slash(createdPaths.dtsRelPath), gqlContent];

    // Old caches left will be removed
    oldGqlHashes.delete(gqlHash);
  }

  // Run codegen to write .tsx
  await processGraphQLCodegenForLiterals(
    execContext,
    literalCodegenContext,
    sourceRelPath,
  );

  // Remove old caches
  for (const oldGqlHash of oldGqlHashes) {
    delete partialCache[oldGqlHash];
    const { dtsFullPath } = createPaths(
      sourceRelPath,
      oldGqlHash,
      dtsRelDir,
      cacheFullDir,
      cwd,
    );
    if (existsSync(dtsFullPath)) {
      await rimraf(dtsFullPath);
    }
  }
}

export async function processLiteralsForContext(
  execContext: ExecContext,
  schemaHash: string,
  sourceRelPaths: string[],
  codegenContext: CodegenContext[],
) {
  if (!sourceRelPaths.length) return;

  const { cwd } = execContext;

  const visitedSources: {
    visitLiteralCallResults: VisitedCallExpressionResults;
    programPath: NodePath<t.Program>;
    sourceFullPath: string;
    sourceRelPath: string;
  }[] = [];

  for (const sourceRelPath of sourceRelPaths) {
    const sourceFullPath = pathJoin(cwd, sourceRelPath);
    const sourceContent = await readFile(pathJoin(cwd, sourceRelPath), 'utf-8');
    const sourceAST = parse(sourceContent, parserOption);
    traverse(sourceAST, {
      Program(programPath: NodePath<t.Program>) {
        const visitLiteralCallResults = visitFromProgramPath(programPath);
        // TODO: Handle error
        // There's no `gql(`query {}`)` in the source
        if (!visitLiteralCallResults.callExpressionPathPairs.length) return;

        visitedSources.push({
          visitLiteralCallResults,
          programPath,
          sourceFullPath,
          sourceRelPath,
        });
      },
    });
  }

  const cache = new TypeCache(execContext);
  await cache.load();

  for (const visited of visitedSources) {
    const scopedCodegenContext: LiteralCodegenContext[] = [];
    const {
      visitLiteralCallResults,
      programPath,
      sourceFullPath,
      sourceRelPath,
    } = visited;
    const { callExpressionPathPairs } = visitLiteralCallResults;

    const gqlContents = callExpressionPathPairs.map(([, value]) => value);

    await processLiteralsDeprecated(
      execContext,
      sourceRelPath,
      schemaHash,
      gqlContents,
      scopedCodegenContext,
      cache.get(sourceRelPath),
    );
    modifyLiteralCalls(
      programPath,
      sourceFullPath,
      callExpressionPathPairs,
      scopedCodegenContext,
    );
    for (const context of scopedCodegenContext) codegenContext.push(context);
  }

  await cache.unload();
}

// export const processLiteralsWithDtsGenerateSync = toSync<
//   typeof processLiteralsWithDtsGenerate
// >('dist/lib/literals/literals', 'processLiteralsWithDtsGenerate');