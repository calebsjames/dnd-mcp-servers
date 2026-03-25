#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as ts from "typescript";
import { readFileSync, existsSync } from "fs";
import { glob } from "glob";
import { relative, resolve } from "path";

interface Violation {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  rule: string;
  message: string;
  suggestedFix?: string;
}

// Helper: Read and parse TypeScript file
function parseTypeScriptFile(filePath: string): ts.SourceFile {
  const fileContent = readFileSync(filePath, "utf-8");
  return ts.createSourceFile(
    filePath,
    fileContent,
    ts.ScriptTarget.Latest,
    true
  );
}

// Helper: Get line and column from position
function getLineAndColumn(sourceFile: ts.SourceFile, position: number) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: line + 1, column: character + 1 };
}

// Helper: Get decorator names from a node (uses ts.getDecorators for TS 5.x compatibility)
function getDecoratorNames(node: ts.Node, sourceFile: ts.SourceFile): string[] {
  if (!ts.canHaveDecorators(node)) return [];
  const decorators = ts.getDecorators(node);
  if (!decorators) return [];
  return decorators.map((d) => {
    if (ts.isCallExpression(d.expression)) {
      const expr = d.expression.expression;
      return ts.isIdentifier(expr) ? expr.text : expr.getText(sourceFile);
    }
    if (ts.isIdentifier(d.expression)) return d.expression.text;
    return d.expression.getText(sourceFile);
  });
}

// Helper: Get decorators from a node
function getNodeDecorators(node: ts.Node): readonly ts.Decorator[] {
  if (!ts.canHaveDecorators(node)) return [];
  return ts.getDecorators(node) ?? [];
}

// ─── Frontend: Adapter Validation ─────────────────────────────────────────────

function validateAdapter(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const sourceFile = parseTypeScriptFile(filePath);

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node)) {
      node.members.forEach((member) => {
        if (ts.isMethodDeclaration(member)) {
          const methodName = member.name?.getText(sourceFile);
          const pos = getLineAndColumn(sourceFile, member.getStart(sourceFile));
          const hasStatic = member.modifiers?.some(
            (mod) => mod.kind === ts.SyntaxKind.StaticKeyword
          );
          const hasAsync = member.modifiers?.some(
            (mod) => mod.kind === ts.SyntaxKind.AsyncKeyword
          );

          if (!hasStatic) {
            violations.push({
              file: filePath, line: pos.line, column: pos.column, severity: "error",
              rule: "adapter-static-methods",
              message: `Adapter method '${methodName}' must be static`,
              suggestedFix: "static async methodName()",
            });
          }

          if (!hasAsync) {
            violations.push({
              file: filePath, line: pos.line, column: pos.column, severity: "error",
              rule: "adapter-async-methods",
              message: `Adapter method '${methodName}' must be async`,
              suggestedFix: "static async methodName()",
            });
          }
        }
      });
    }

    if (ts.isTryStatement(node)) {
      const pos = getLineAndColumn(sourceFile, node.getStart(sourceFile));
      violations.push({
        file: filePath, line: pos.line, column: pos.column, severity: "warning",
        rule: "adapter-no-try-catch",
        message: "Adapters should not have try/catch blocks (handled by service layer)",
        suggestedFix: "Remove try/catch, let errors propagate to service",
      });
    }

    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text === "console") {
        const pos = getLineAndColumn(sourceFile, node.getStart(sourceFile));
        violations.push({
          file: filePath, line: pos.line, column: pos.column, severity: "error",
          rule: "adapter-no-console-log",
          message: "Adapters should not use console.log (no logging in adapters)",
          suggestedFix: "Remove console.log statement",
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

// ─── Frontend: Service Validation ─────────────────────────────────────────────

function validateFrontendService(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const sourceFile = parseTypeScriptFile(filePath);

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node)) {
      node.members.forEach((member) => {
        if (ts.isMethodDeclaration(member)) {
          const methodName = member.name?.getText(sourceFile);
          const pos = getLineAndColumn(sourceFile, member.getStart(sourceFile));
          const hasStatic = member.modifiers?.some(
            (mod) => mod.kind === ts.SyntaxKind.StaticKeyword
          );
          const hasAsync = member.modifiers?.some(
            (mod) => mod.kind === ts.SyntaxKind.AsyncKeyword
          );

          let containsAwait = false;
          function checkForAwait(n: ts.Node) {
            if (ts.isAwaitExpression(n)) { containsAwait = true; return; }
            ts.forEachChild(n, checkForAwait);
          }
          if (member.body) checkForAwait(member.body);

          if (!hasStatic) {
            violations.push({
              file: filePath, line: pos.line, column: pos.column, severity: "error",
              rule: "service-static-methods",
              message: `Service method '${methodName}' must be static`,
              suggestedFix: "static async methodName()",
            });
          }

          if (!hasAsync && containsAwait) {
            violations.push({
              file: filePath, line: pos.line, column: pos.column, severity: "warning",
              rule: "service-async-methods",
              message: `Service method '${methodName}' contains await but is not declared async`,
              suggestedFix: "static async methodName()",
            });
          }
        }
      });
    }

    if (ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent)) {
      const methodBody = node.body;
      const isAsync = node.modifiers?.some(
        (mod) => mod.kind === ts.SyntaxKind.AsyncKeyword
      );
      if (methodBody && isAsync) {
        let hasTryCatch = false;
        methodBody.statements.forEach((stmt) => {
          if (ts.isTryStatement(stmt)) hasTryCatch = true;
        });
        if (!hasTryCatch) {
          const methodName = node.name?.getText(sourceFile);
          const pos = getLineAndColumn(sourceFile, node.getStart(sourceFile));
          const isPrivate = node.modifiers?.some(
            (mod) => mod.kind === ts.SyntaxKind.PrivateKeyword
          );
          if (!isPrivate && methodName && !methodName.startsWith("_")) {
            violations.push({
              file: filePath, line: pos.line, column: pos.column, severity: "warning",
              rule: "service-try-catch",
              message: `Async service method '${methodName}' should wrap adapter calls in try/catch with console.error`,
              suggestedFix: "try { return await Adapter.method(); } catch (error) { console.error('Error:', error); throw error; }",
            });
          }
        }
      }
    }

    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      node.exportClause.elements.forEach((element) => {
        const exportedName = element.name.text;
        if (exportedName.endsWith("Service") && exportedName[0] === exportedName[0].toLowerCase()) {
          const pos = getLineAndColumn(sourceFile, element.getStart(sourceFile));
          violations.push({
            file: filePath, line: pos.line, column: pos.column, severity: "error",
            rule: "service-no-lowercase-alias",
            message: `Service exported with lowercase alias '${exportedName}' — export PascalCase only`,
            suggestedFix: "Remove the alias export. Import using the class name: import { FooService } from '@/services/fooService'",
          });
        }
      });
    }

    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text === "console" &&
          expr.name.text === "log") {
        const pos = getLineAndColumn(sourceFile, node.getStart(sourceFile));
        violations.push({
          file: filePath, line: pos.line, column: pos.column, severity: "warning",
          rule: "service-no-console-log",
          message: "Services should use console.error in catch blocks, not console.log",
          suggestedFix: "console.error('Error message:', error)",
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

// ─── Backend: DTO Validation ───────────────────────────────────────────────────

function validateDto(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const sourceFile = parseTypeScriptFile(filePath);

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node)) {
      for (const member of node.members) {
        if (!ts.isPropertyDeclaration(member)) continue;
        const decoratorNames = getDecoratorNames(member, sourceFile);
        const pos = getLineAndColumn(sourceFile, member.getStart(sourceFile));
        const propName = member.name?.getText(sourceFile) ?? "unknown";

        // Rule: @IsString() must have @MaxLength()
        if (decoratorNames.includes("IsString") && !decoratorNames.includes("MaxLength")) {
          violations.push({
            file: filePath, line: pos.line, column: pos.column, severity: "error",
            rule: "dto-maxlength-required",
            message: `Property '${propName}' has @IsString() but no @MaxLength() — required to prevent DoS`,
            suggestedFix: `Add @MaxLength(255) (or appropriate limit) above @IsString()`,
          });
        }

        // Rule: @IsString({ each: true }) must also have @IsArray()
        const hasIsStringEach = getNodeDecorators(member)
          .some((d) => {
            if (!ts.isCallExpression(d.expression)) return false;
            const expr = d.expression.expression;
            if (!ts.isIdentifier(expr) || expr.text !== "IsString") return false;
            const arg = d.expression.arguments[0];
            if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
            return arg.properties.some((p) =>
              ts.isPropertyAssignment(p) &&
              p.name.getText(sourceFile) === "each" &&
              p.initializer.kind === ts.SyntaxKind.TrueKeyword
            );
          });

        if (hasIsStringEach && !decoratorNames.includes("IsArray")) {
          violations.push({
            file: filePath, line: pos.line, column: pos.column, severity: "warning",
            rule: "dto-array-needs-isarray",
            message: `Property '${propName}' uses @IsString({ each: true }) but is missing @IsArray()`,
            suggestedFix: "Add @IsArray() above @IsString({ each: true })",
          });
        }

        // Rule: Fields named *Id or *Uuid should have @IsUUID()
        const lowerName = propName.toLowerCase();
        if ((lowerName.endsWith("id") || lowerName.endsWith("uuid")) &&
            lowerName !== "id" &&
            decoratorNames.some((d) => d.startsWith("Is")) &&
            !decoratorNames.includes("IsUUID") &&
            !decoratorNames.includes("IsOptional")) {
          violations.push({
            file: filePath, line: pos.line, column: pos.column, severity: "warning",
            rule: "dto-uuid-field",
            message: `Property '${propName}' looks like a UUID reference but missing @IsUUID()`,
            suggestedFix: "Add @IsUUID() if this field accepts a UUID value",
          });
        }

        // Rule: No property without any validation decorator (unless it has @IsOptional or @Expose)
        const hasValidation = decoratorNames.some((d) =>
          d.startsWith("Is") || d.startsWith("Min") || d.startsWith("Max") ||
          d === "ArrayMinSize" || d === "ArrayMaxSize" || d === "ValidateNested"
        );
        const hasTransformOnly = decoratorNames.every((d) =>
          ["Type", "Transform", "Expose", "Exclude", "ApiProperty", "ApiPropertyOptional"].includes(d)
        );
        if (!hasValidation && !hasTransformOnly && decoratorNames.length > 0) {
          violations.push({
            file: filePath, line: pos.line, column: pos.column, severity: "warning",
            rule: "dto-missing-validation",
            message: `Property '${propName}' has no class-validator decorator`,
            suggestedFix: "Add appropriate @Is*() validator or @IsOptional()",
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

// ─── Backend: Controller Validation ───────────────────────────────────────────

function validateController(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const sourceFile = parseTypeScriptFile(filePath);

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node)) {
      const className = node.name?.text ?? "Unknown";

      // Rule: Must have private readonly logger = new Logger(ClassName.name)
      const hasLogger = node.members.some((m) => {
        if (!ts.isPropertyDeclaration(m)) return false;
        const name = m.name?.getText(sourceFile) ?? "";
        return name === "logger";
      });
      if (!hasLogger) {
        const pos = getLineAndColumn(sourceFile, node.getStart(sourceFile));
        violations.push({
          file: filePath, line: pos.line, column: pos.column, severity: "warning",
          rule: "controller-needs-logger",
          message: `Controller '${className}' is missing 'private readonly logger = new Logger(${className}.name)'`,
          suggestedFix: `Add: private readonly logger = new Logger(${className}.name);`,
        });
      }

      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const methodName = member.name?.getText(sourceFile) ?? "unknown";
        const methodPos = getLineAndColumn(sourceFile, member.getStart(sourceFile));

        // Rule: @Param('*id*') must use ParseUUIDPipe
        if (member.parameters) {
          for (const param of member.parameters) {
            const paramDecorators = getNodeDecorators(param);

            for (const dec of paramDecorators) {
              if (!ts.isCallExpression(dec.expression)) continue;
              const expr = dec.expression.expression;
              if (!ts.isIdentifier(expr) || expr.text !== "Param") continue;

              const firstArg = dec.expression.arguments[0];
              const paramRouteName = firstArg && ts.isStringLiteral(firstArg)
                ? firstArg.text.toLowerCase()
                : "";

              if (paramRouteName.includes("id") || paramRouteName.includes("uuid")) {
                const hasParseUUID = dec.expression.arguments.length >= 2 &&
                  dec.expression.arguments.some((a: ts.Expression) =>
                    (ts.isIdentifier(a) && a.text === "ParseUUIDPipe") ||
                    (ts.isNewExpression(a) && ts.isIdentifier(a.expression) && a.expression.text === "ParseUUIDPipe")
                  );
                if (!hasParseUUID) {
                  const pos = getLineAndColumn(sourceFile, dec.getStart(sourceFile));
                  violations.push({
                    file: filePath, line: pos.line, column: pos.column, severity: "error",
                    rule: "controller-parse-uuid-pipe",
                    message: `Method '${methodName}': @Param('${paramRouteName}') must use ParseUUIDPipe`,
                    suggestedFix: `@Param('${paramRouteName}', ParseUUIDPipe) ${paramRouteName}: string`,
                  });
                }
              }
            }
          }
        }

        // Rule: Methods should have @ApiOperation
        const methodDecoratorNames = getDecoratorNames(member, sourceFile);
        const hasHttpMethod = methodDecoratorNames.some((d) =>
          ["Get", "Post", "Put", "Patch", "Delete"].includes(d)
        );
        if (hasHttpMethod && !methodDecoratorNames.includes("ApiOperation")) {
          violations.push({
            file: filePath, line: methodPos.line, column: methodPos.column, severity: "warning",
            rule: "controller-api-operation",
            message: `Method '${methodName}' is missing @ApiOperation({ summary: '...' })`,
            suggestedFix: `Add @ApiOperation({ summary: 'Brief description of what this endpoint does' })`,
          });
        }
      }
    }

    // Rule: No throw new Error() — use NestJS exceptions
    if (ts.isThrowStatement(node)) {
      const expr = node.expression;
      if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "Error") {
        const pos = getLineAndColumn(sourceFile, node.getStart(sourceFile));
        violations.push({
          file: filePath, line: pos.line, column: pos.column, severity: "error",
          rule: "controller-no-raw-error",
          message: "Do not use 'throw new Error()' in controllers — use NestJS HTTP exceptions",
          suggestedFix: "throw new NotFoundException('...') | BadRequestException | ConflictException | InternalServerErrorException",
        });
      }
    }

    // Rule: No console.log — use this.logger
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text === "console" &&
          expr.name.text === "log") {
        const pos = getLineAndColumn(sourceFile, node.getStart(sourceFile));
        violations.push({
          file: filePath, line: pos.line, column: pos.column, severity: "warning",
          rule: "controller-no-console-log",
          message: "Use this.logger.log/warn/error instead of console.log",
          suggestedFix: "this.logger.log('message') or this.logger.error('message', error.stack)",
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

// ─── Backend: Service Validation ──────────────────────────────────────────────

function validateBackendService(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const sourceFile = parseTypeScriptFile(filePath);

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node)) {
      const className = node.name?.text ?? "Unknown";

      // Rule: Must have private readonly logger = new Logger(ClassName.name)
      const hasLogger = node.members.some((m) => {
        if (!ts.isPropertyDeclaration(m)) return false;
        const name = m.name?.getText(sourceFile) ?? "";
        return name === "logger";
      });
      if (!hasLogger) {
        const pos = getLineAndColumn(sourceFile, node.getStart(sourceFile));
        violations.push({
          file: filePath, line: pos.line, column: pos.column, severity: "warning",
          rule: "service-needs-logger",
          message: `Service '${className}' is missing 'private readonly logger = new Logger(${className}.name)'`,
          suggestedFix: `Add: private readonly logger = new Logger(${className}.name);`,
        });
      }
    }

    // Rule: No throw new Error() — use NestJS exceptions
    if (ts.isThrowStatement(node)) {
      const expr = node.expression;
      if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "Error") {
        const pos = getLineAndColumn(sourceFile, node.getStart(sourceFile));
        violations.push({
          file: filePath, line: pos.line, column: pos.column, severity: "error",
          rule: "service-no-raw-error",
          message: "Do not use 'throw new Error()' in services — use NestJS HTTP exceptions",
          suggestedFix: "throw new NotFoundException('...') | BadRequestException | ConflictException | InternalServerErrorException",
        });
      }
    }

    // Rule: No console.log — use this.logger
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text === "console" &&
          expr.name.text === "log") {
        const pos = getLineAndColumn(sourceFile, node.getStart(sourceFile));
        violations.push({
          file: filePath, line: pos.line, column: pos.column, severity: "warning",
          rule: "service-no-console-log",
          message: "Use this.logger.log/warn/error instead of console.log in backend services",
          suggestedFix: "this.logger.log('message') or this.logger.error('message', error.stack)",
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

// ─── Frontend: Batch Audits ────────────────────────────────────────────────────

async function auditFrontendAdapters(directory: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const adapterFiles = await glob(`${directory}/**/*Adapter.ts`, {
    ignore: ["**/node_modules/**", "**/dist/**", "**/apiClient.ts"]
  });
  const adapterFilesLower = await glob(`${directory}/**/*adapter.ts`, {
    ignore: ["**/node_modules/**", "**/dist/**", "**/apiClient.ts"]
  });
  const allFiles = [...new Set([...adapterFiles, ...adapterFilesLower])];
  for (const file of allFiles) violations.push(...validateAdapter(file));
  return violations;
}

async function auditFrontendServices(directory: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const serviceFiles = await glob(`${directory}/**/*Service.ts`, {
    ignore: ["**/node_modules/**", "**/dist/**", "**/*.spec.ts", "**/*.test.ts"]
  });
  const serviceFilesLower = await glob(`${directory}/**/*service.ts`, {
    ignore: ["**/node_modules/**", "**/dist/**", "**/*.spec.ts", "**/*.test.ts"]
  });
  const allFiles = [...new Set([...serviceFiles, ...serviceFilesLower])];
  for (const file of allFiles) violations.push(...validateFrontendService(file));
  return violations;
}

async function runSecurityAudit(directory: string): Promise<Violation[]> {
  const violations = await auditFrontendAdapters(directory);
  violations.push(...(await auditFrontendServices(directory)));
  return violations;
}

// ─── Backend: Batch Audits ─────────────────────────────────────────────────────

async function auditBackendDtos(directory: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const files = await glob(`${directory}/**/*.dto.ts`, {
    ignore: ["**/node_modules/**", "**/dist/**"]
  });
  for (const file of files) violations.push(...validateDto(file));
  return violations;
}

async function auditBackendControllers(directory: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const files = await glob(`${directory}/**/*.controller.ts`, {
    ignore: ["**/node_modules/**", "**/dist/**", "**/*.spec.ts"]
  });
  for (const file of files) violations.push(...validateController(file));
  return violations;
}

async function auditBackendServices(directory: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const files = await glob(`${directory}/**/*.service.ts`, {
    ignore: ["**/node_modules/**", "**/dist/**", "**/*.spec.ts"]
  });
  for (const file of files) violations.push(...validateBackendService(file));
  return violations;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "dnd-code-standards", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Tool[] = [
    // ── Frontend tools ──
    {
      name: "validate_adapter",
      description: "Validate a frontend adapter file (checks static methods, no try/catch, no console.log)",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string", description: "Absolute or relative path to the adapter file" } },
        required: ["filePath"],
      },
    },
    {
      name: "validate_service",
      description: "Validate a frontend service file (checks static methods, try/catch, error handling, no console.log)",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string", description: "Absolute or relative path to the service file" } },
        required: ["filePath"],
      },
    },
    {
      name: "audit_frontend_adapters",
      description: "Batch validate all frontend adapter files in a directory (checks static methods, no try/catch, no console.log)",
      inputSchema: {
        type: "object",
        properties: { directory: { type: "string", description: "Directory containing adapter files (e.g., 'dnd-ui/src/adapters')" } },
        required: ["directory"],
      },
    },
    {
      name: "audit_frontend_services",
      description: "Batch validate all frontend service files in a directory (checks static methods, try/catch, error handling)",
      inputSchema: {
        type: "object",
        properties: { directory: { type: "string", description: "Directory containing service files (e.g., 'dnd-ui/src/services')" } },
        required: ["directory"],
      },
    },
    {
      name: "run_security_audit",
      description: "Run full security audit on a directory (validates all adapters and services)",
      inputSchema: {
        type: "object",
        properties: { directory: { type: "string", description: "Directory to audit (e.g., 'src' or an absolute path to dnd-ui/src)" } },
        required: ["directory"],
      },
    },
    // ── Backend tools ──
    {
      name: "validate_dto",
      description: "Validate a NestJS DTO file. Checks: @IsString() must have @MaxLength(), @IsString({each:true}) needs @IsArray(), UUID fields need @IsUUID(), all properties have validation decorators.",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string", description: "Absolute path to the .dto.ts file" } },
        required: ["filePath"],
      },
    },
    {
      name: "validate_controller",
      description: "Validate a NestJS controller file. Checks: Logger present, @Param UUID fields use ParseUUIDPipe, @ApiOperation on HTTP methods, no throw new Error(), no console.log.",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string", description: "Absolute path to the .controller.ts file" } },
        required: ["filePath"],
      },
    },
    {
      name: "validate_service_backend",
      description: "Validate a NestJS service file. Checks: Logger present, no throw new Error() (use NestJS exceptions), no console.log (use this.logger).",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string", description: "Absolute path to the .service.ts file" } },
        required: ["filePath"],
      },
    },
    {
      name: "audit_backend_dtos",
      description: "Batch validate all *.dto.ts files in a directory against dnd-api DTO standards.",
      inputSchema: {
        type: "object",
        properties: { directory: { type: "string", description: "Directory to scan (e.g., absolute path to dnd-api/src/dto)" } },
        required: ["directory"],
      },
    },
    {
      name: "audit_backend_controllers",
      description: "Batch validate all *.controller.ts files in a directory against dnd-api controller standards.",
      inputSchema: {
        type: "object",
        properties: { directory: { type: "string", description: "Directory to scan (e.g., absolute path to dnd-api/src)" } },
        required: ["directory"],
      },
    },
    {
      name: "audit_backend_services",
      description: "Batch validate all *.service.ts files in a directory against dnd-api service standards.",
      inputSchema: {
        type: "object",
        properties: { directory: { type: "string", description: "Directory to scan (e.g., absolute path to dnd-api/src)" } },
        required: ["directory"],
      },
    },
  ];

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) throw new Error("Missing arguments");

  try {
    let violations: Violation[] = [];
    let filePath: string;

    switch (name) {
      case "validate_adapter":
        filePath = resolve(args.filePath as string);
        if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
        violations = validateAdapter(filePath);
        break;

      case "validate_service":
        filePath = resolve(args.filePath as string);
        if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
        violations = validateFrontendService(filePath);
        break;

      case "audit_frontend_adapters":
        violations = await auditFrontendAdapters(args.directory as string);
        break;

      case "audit_frontend_services":
        violations = await auditFrontendServices(args.directory as string);
        break;

      case "run_security_audit":
        violations = await runSecurityAudit(args.directory as string);
        break;

      case "validate_dto":
        filePath = resolve(args.filePath as string);
        if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
        violations = validateDto(filePath);
        break;

      case "validate_controller":
        filePath = resolve(args.filePath as string);
        if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
        violations = validateController(filePath);
        break;

      case "validate_service_backend":
        filePath = resolve(args.filePath as string);
        if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
        violations = validateBackendService(filePath);
        break;

      case "audit_backend_dtos":
        violations = await auditBackendDtos(args.directory as string);
        break;

      case "audit_backend_controllers":
        violations = await auditBackendControllers(args.directory as string);
        break;

      case "audit_backend_services":
        violations = await auditBackendServices(args.directory as string);
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    const errors = violations.filter((v) => v.severity === "error");
    const warnings = violations.filter((v) => v.severity === "warning");

    const summary = {
      totalViolations: violations.length,
      errors: errors.length,
      warnings: warnings.length,
      violations: violations.map((v) => ({
        file: relative(process.cwd(), v.file),
        location: `${v.file}:${v.line}:${v.column}`,
        severity: v.severity,
        rule: v.rule,
        message: v.message,
        suggestedFix: v.suggestedFix,
      })),
    };

    return {
      content: [{
        type: "text",
        text: violations.length === 0
          ? "No violations found! Code meets all standards."
          : JSON.stringify(summary, null, 2),
      }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("DnD Code Standards MCP Server running (v2.0.0 — backend + frontend)");
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
