import { loadConfigSync } from '../lib/config';
import { CodegenConfigForLiteralDocumentsDeprecated } from '../lib/documents';
import { processDtsForContext } from '../lib/dts';
import createExecContext, { ExecContext } from '../lib/exec-context';
import { processGraphQLCodegen } from '../lib/graphql-codegen';
import {
  createSchemaHashSync,
  shouldGenResolverTypes,
} from '../lib/resolver-types';
import { toSync } from '../lib/to-sync';
import { CodegenContext } from '../lib/types';

// TODO: name of function
export function prepareCodegenArgs(cwd: string) {
  const [config, configHash] = loadConfigSync(cwd, undefined);
  const execContext = createExecContext(cwd, config, configHash);
  let schemaHash = configHash;
  if (shouldGenResolverTypes(config))
    schemaHash = createSchemaHashSync(execContext);
  return { execContext, schemaHash };
}

export async function generateForContext(
  execContext: ExecContext,
  codegenContext: CodegenContext[],
  sourceRelPath: string,
) {
  await processGraphQLCodegen(
    execContext,
    codegenContext,
    new CodegenConfigForLiteralDocumentsDeprecated(
      execContext,
      codegenContext,
      sourceRelPath,
    ),
  );
  await processDtsForContext(execContext, codegenContext);
}

export const generateForContextSync = toSync(generateForContext);