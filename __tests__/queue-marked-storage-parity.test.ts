import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface ProjectionColumn {
  name: string;
  nullable: boolean;
  prismaType: string;
}

interface ProjectionModel {
  model: string;
  columns: ProjectionColumn[];
}

interface StorageProjection {
  version: string;
  agentMessage: { models: ProjectionModel[] };
  durableTables: ProjectionModel[];
}

const projectionPath = new URL(
  '../vendor/scrum4me-shared/fixtures/parallel-plan-execution/storage-projection-v1.json',
  import.meta.url,
);
const schemaPath = new URL('../prisma/schema.prisma', import.meta.url);

function modelBlock(schema: string, model: string): string {
  const match = new RegExp(`model\\s+${model}\\s+\\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!match) throw new Error(`generated schema mist model ${model}`);
  return match[1];
}

function fieldLine(block: string, field: string): string {
  const match = new RegExp(`^\\s*${field}\\s+([^\\n]+)$`, 'm').exec(block);
  if (!match) throw new Error(`generated schema mist veld ${field}`);
  return match[1].trim();
}

function fieldType(line: string): string {
  return line.split(/\s+/)[0];
}

function nativeType(line: string): string | null {
  return /@db\.[A-Za-z]+(?:\(\d+\))?/.exec(line)?.[0] ?? null;
}

function expectedNativeType(prismaType: string): string | null {
  return /@db\.[A-Za-z]+(?:\(\d+\))?/.exec(prismaType)?.[0] ?? null;
}

describe('generated marked-storage consumer parity', () => {
  it('matches every Plan A projection field type and nullability from the pinned shared commit', () => {
    const projectionBytes = readFileSync(projectionPath);
    expect(createHash('sha256').update(projectionBytes).digest('hex'))
      .toBe('a9489ef41ec3cf1d0f8f2190d21e7b1875dbb88a990c1c60fcef9367d3863a05');
    const projection = JSON.parse(projectionBytes.toString('utf8')) as StorageProjection;
    expect(projection.version).toBe('parallel-plan-execution-storage/v1');

    const schema = readFileSync(schemaPath, 'utf8');
    const models = [...projection.agentMessage.models, ...projection.durableTables];
    for (const model of models) {
      const block = modelBlock(schema, model.model);
      for (const column of model.columns) {
        const line = fieldLine(block, column.name);
        expect(fieldType(line), `${model.model}.${column.name} type`).toBe(column.prismaType.split(/\s+/)[0]);
        expect(fieldType(line).endsWith('?'), `${model.model}.${column.name} nullability`).toBe(column.nullable);
        expect(nativeType(line), `${model.model}.${column.name} native type`).toBe(expectedNativeType(column.prismaType));
        expect(line.includes('@id'), `${model.model}.${column.name} id`).toBe(column.prismaType.includes('@id'));
      }
    }

    for (const model of projection.agentMessage.models) {
      const actualMarkers = modelBlock(schema, model.model)
        .split('\n')
        .map((line) => /^\s*(ppe_[a-z0-9_]+)\s+(String\?|Int\?|BigInt\?)(?:\s|$)/.exec(line)?.[1])
        .filter((value): value is string => value !== undefined);
      expect(actualMarkers).toEqual(model.columns.map(({ name }) => name));
    }
  });
});
