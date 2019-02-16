// @flow
import type {
  Program,
  SourceLocation,
  Node,
  TypeAnnotation,
  TypeParameter,
  Declaration
} from "@babel/parser";
import traverseTree from "../utils/traverse";
import NODE from "../utils/nodes";
import checkCalls from "../checking";
import HegelError from "../utils/errors";
import mixBaseGlobals from "../utils/globals";
import mixBaseOperators from "../utils/operators";
import {
  getInvocationType,
  inferenceErrorType,
  inferenceTypeForNode,
  inferenceFunctionTypeByScope
} from "../inference";
import {
  getScopeKey,
  getNameForType,
  getAnonymousKey,
  findVariableInfo,
  getParentFromNode,
  findThrowableBlock,
  getDeclarationName,
  findNearestTypeScope,
  findNearestScopeByType,
  getTypeFromTypeAnnotation,
  getFunctionTypeLiteral
} from "../utils/utils";
import {
  Type,
  TypeVar,
  CallMeta,
  ObjectType,
  FunctionType,
  GenericType,
  VariableInfo,
  Scope,
  Meta,
  ModuleScope,
  TYPE_SCOPE,
  UNDEFINED_TYPE
} from "./types";
import type { TraverseMeta } from "../utils/traverse";
import type { CallableArguments } from "./types";

const getScopeType = (node: Node): $PropertyType<Scope, "type"> => {
  switch (node.type) {
    case NODE.BLOCK_STATEMENT:
      return Scope.BLOCK_TYPE;
    case NODE.FUNCTION_DECLARATION:
    case NODE.FUNCTION_EXPRESSION:
    case NODE.ARROW_FUNCTION_EXPRESSION:
    case NODE.OBJECT_METHOD:
    case NODE.FUNCTION_TYPE_ANNOTATION:
      return Scope.FUNCTION_TYPE;
    case NODE.OBJECT_EXPRESSION:
      return Scope.OBJECT_TYPE;
    case NODE.CLASS_DECLARATION:
    case NODE.CLASS_EXPRESSION:
      return Scope.CLASS_TYPE;
  }
  throw new TypeError("Never for getScopeType");
};

const getTypeScope = (scope: Scope | ModuleScope): Scope => {
  const typeScope = scope.body.get(TYPE_SCOPE);
  if (typeScope instanceof Scope) {
    return typeScope;
  }
  if (scope.parent) {
    return getTypeScope(scope.parent);
  }
  throw new TypeError("Never");
};

const addToThrowable = (
  throwType: Type | VariableInfo,
  currentScope: Scope | ModuleScope
) => {
  const throwableScope = findThrowableBlock(currentScope);
  if (!throwableScope || !throwableScope.throwable) {
    return;
  }
  const { throwable } = throwableScope;
  if (currentScope instanceof Scope) {
    throwable.push(throwType);
  }
};

const addCallToTypeGraph = (
  node: Node,
  typeGraph: ModuleScope,
  currentScope: Scope | ModuleScope
): CallableArguments => {
  let target: ?VariableInfo = null;
  let targetName: string = "";
  let args: ?Array<CallableArguments> = null;
  const typeScope = findNearestTypeScope(currentScope, typeGraph);
  if (!(typeScope instanceof Scope)) {
    throw new Error("Never!");
  }
  switch (node.type) {
    case NODE.IF_STATEMENT:
      target = findVariableInfo({ name: "if" }, currentScope);
      args = [addCallToTypeGraph(node.test, typeGraph, currentScope)];
      break;
    case NODE.WHILE_STATEMENT:
      target = findVariableInfo({ name: "while" }, currentScope);
      args = [addCallToTypeGraph(node.test, typeGraph, currentScope)];
      break;
    case NODE.DO_WHILE_STATEMENT:
      target = findVariableInfo({ name: "do-while" }, currentScope);
      args = [addCallToTypeGraph(node.test, typeGraph, currentScope)];
      break;
    case NODE.FOR_STATEMENT:
      target = findVariableInfo({ name: "for" }, currentScope);
      args = [
        Type.createTypeWithName("mixed", typeScope),
        node.test
          ? addCallToTypeGraph(
              node.test,
              typeGraph,
              // $FlowIssue
              typeGraph.body.get(getScopeKey(node.body))
            )
          : Type.createTypeWithName("undefined", typeScope),
        Type.createTypeWithName("mixed", typeScope)
      ];
      break;
    case NODE.FUNCTION_EXPRESSION:
    case NODE.ARROW_FUNCTION_EXPRESSION:
    case NODE.CLASS_DECLARATION:
    case NODE.IDENTIFIER:
      const nodeName =
        node.type === NODE.IDENTIFIER ? node : { name: getAnonymousKey(node) };
      return findVariableInfo(nodeName, currentScope);
    case NODE.VARIABLE_DECLARATOR:
      const variableType = findVariableInfo(node.id, currentScope);
      if (!node.init) {
        return variableType;
      }
      args = [
        variableType,
        addCallToTypeGraph(node.init, typeGraph, currentScope)
      ];
      targetName = "=";
      target = findVariableInfo({ name: targetName }, currentScope);
      break;
    case NODE.EXPRESSION_STATEMENT:
      return addCallToTypeGraph(node.expression, typeGraph, currentScope);
    case NODE.THROW_STATEMENT:
      args = [addCallToTypeGraph(node.argument, typeGraph, currentScope)];
      targetName = "throw";
      target = findVariableInfo({ name: targetName }, currentScope);
      addToThrowable(args[0], currentScope);
      break;
    case NODE.RETURN_STATEMENT:
    case NODE.UNARY_EXPRESSION:
    case NODE.UPDATE_EXPRESSION:
      args = [addCallToTypeGraph(node.argument, typeGraph, currentScope)];
      targetName = node.operator || "return";
      target = findVariableInfo({ name: targetName }, currentScope);
      break;
    case NODE.BINARY_EXPRESSION:
    case NODE.LOGICAL_EXPRESSION:
      args = [
        addCallToTypeGraph(node.left, typeGraph, currentScope),
        addCallToTypeGraph(node.right, typeGraph, currentScope)
      ];
      targetName = node.operator;
      target = findVariableInfo({ name: targetName }, currentScope);
      break;
    case NODE.ASSIGNMENT_EXPRESSION:
      args = [
        addCallToTypeGraph(node.left, typeGraph, currentScope),
        addCallToTypeGraph(node.right, typeGraph, currentScope)
      ];
      targetName = node.operator;
      target = findVariableInfo({ name: targetName }, currentScope);
      break;
    case NODE.MEMBER_EXPRESSION:
      args = [
        addCallToTypeGraph(node.object, typeGraph, currentScope),
        new Type(node.name, {
          isLiteralOf: Type.createTypeWithName(
            "string",
            typeGraph.body.get(TYPE_SCOPE)
          )
        })
      ];
      targetName = ".";
      target = findVariableInfo({ name: targetName }, currentScope);
      break;
    case NODE.CONDITIONAL_EXPRESSION:
      args = [
        addCallToTypeGraph(node.test, typeGraph, currentScope),
        addCallToTypeGraph(node.consequent, typeGraph, currentScope),
        addCallToTypeGraph(node.alternate, typeGraph, currentScope)
      ];
      targetName = "?:";
      target = findVariableInfo({ name: targetName }, currentScope);
      break;
    case NODE.CALL_EXPRESSION:
      args = node.arguments.map(n =>
        addCallToTypeGraph(n, typeGraph, currentScope)
      );
      target =
        node.callee.type === NODE.IDENTIFIER
          ? findVariableInfo(node.callee, currentScope)
          : (addCallToTypeGraph(node.callee, typeGraph, currentScope): any);
      const { throwable } = target;
      if (throwable) {
        addToThrowable(throwable, currentScope);
      }
      break;
    case NODE.NEW_EXPRESSION:
      const argument = addCallToTypeGraph(node.callee, typeGraph, currentScope);
      const argumentType =
        argument instanceof VariableInfo ? argument.type : argument;
      const potentialArgument =
        argumentType instanceof FunctionType ||
        (argumentType instanceof GenericType &&
          argumentType.subordinateType instanceof FunctionType)
          ? getInvocationType(
              argumentType,
              node.arguments.map(a =>
                addCallToTypeGraph(a, typeGraph, currentScope)
              )
            )
          : argumentType;
      args = [
        potentialArgument instanceof ObjectType
          ? potentialArgument
          : ObjectType.createTypeWithName("{ }", typeScope, [])
      ];
      targetName = "new";
      target = findVariableInfo({ name: targetName }, currentScope);
      break;
    default:
      return inferenceTypeForNode(node, typeScope, currentScope, typeGraph);
  }
  const callsScope =
    currentScope.type === Scope.FUNCTION_TYPE
      ? currentScope
      : findNearestScopeByType(Scope.FUNCTION_TYPE, currentScope);
  if (
    target.type instanceof FunctionType ||
    (target.type instanceof GenericType &&
      target.type.subordinateType instanceof FunctionType)
  ) {
    const callMeta = new CallMeta((target: any), args, node.loc, targetName);
    callsScope.calls.push(callMeta);
    return getInvocationType(
      (target.type: any),
      args.map(a => (a instanceof Type ? a : a.type))
    );
  }
  throw new Error(target.constructor.name);
};

const getVariableInfoFromDelcaration = (
  currentNode: Node,
  parentNode: Node,
  typeGraph: ModuleScope
) => {
  const parentScope = getParentFromNode(currentNode, parentNode, typeGraph);
  const currentTypeScope = findNearestTypeScope(parentScope, typeGraph);
  const annotatedType = getTypeFromTypeAnnotation(
    currentNode.id && currentNode.id.typeAnnotation,
    currentTypeScope
  );
  return new VariableInfo(
    /*type:*/ annotatedType,
    parentScope,
    /*meta:*/ new Meta(currentNode.loc)
  );
};

const getScopeFromNode = (
  currentNode: Node,
  parentNode: Node | ModuleScope | Scope,
  typeGraph: ModuleScope,
  declaration?: VariableInfo
) =>
  new Scope(
    /*type:*/ getScopeType(currentNode),
    /*parent:*/ parentNode instanceof Scope || parentNode instanceof ModuleScope
      ? parentNode
      : getParentFromNode(currentNode, parentNode, typeGraph),
    /* declaration */ declaration
  );

const addVariableToGraph = (
  currentNode: Node,
  parentNode: ?Node,
  typeGraph: ModuleScope,
  customName?: string = getDeclarationName(currentNode)
) => {
  const variableInfo = getVariableInfoFromDelcaration(
    currentNode,
    parentNode,
    typeGraph
  );
  variableInfo.parent.body.set(customName, variableInfo);
  return variableInfo;
};

export const addFunctionScopeToTypeGraph = (
  currentNode: Node,
  parentNode: Node | Scope | ModuleScope,
  typeGraph: ModuleScope,
  variableInfo: VariableInfo
) => {
  const scope = getScopeFromNode(
    currentNode,
    parentNode,
    typeGraph,
    variableInfo
  );
  scope.throwable = [];
  typeGraph.body.set(getScopeKey(currentNode), scope);
  if (currentNode.type === NODE.FUNCTION_EXPRESSION && currentNode.id) {
    scope.body.set(getDeclarationName(currentNode), variableInfo);
  }
  const functionType =
    variableInfo.type instanceof GenericType
      ? variableInfo.type.subordinateType
      : variableInfo.type;
  currentNode.params.forEach((id, index) => {
    const type = (functionType: any).argumentsTypes[index];
    scope.body.set(id.name, new VariableInfo(type, scope, new Meta(id.loc)));
  });
};

const addFunctionToTypeGraph = (
  currentNode: Node,
  parentNode: Node,
  typeGraph: ModuleScope
) => {
  const name = currentNode.id
    ? getDeclarationName(currentNode)
    : getAnonymousKey(currentNode);
  const variableInfo = addVariableToGraph(
    currentNode,
    parentNode,
    typeGraph,
    name
  );
  const currentTypeScope = findNearestTypeScope(variableInfo.parent, typeGraph);
  variableInfo.type = inferenceTypeForNode(
    currentNode,
    currentTypeScope,
    variableInfo.parent,
    typeGraph
  );
  addFunctionScopeToTypeGraph(currentNode, parentNode, typeGraph, variableInfo);
};

const hasTypeParams = (node: Node): boolean =>
  node.typeParameters &&
  node.typeParameters.type === NODE.TYPE_PARAMETER_DECLARATION &&
  Array.isArray(node.typeParameters.params) &&
  node.typeParameters.params.length !== 0;

const getGenericNode = (node: Node): ?Node => {
  if (hasTypeParams(node)) {
    return node;
  }
  if (node.right && hasTypeParams(node.right)) {
    return node.right;
  }
  return null;
};

const addTypeAlias = (node: Node, typeGraph: ModuleScope) => {
  const typeScope = typeGraph.body.get(TYPE_SCOPE);
  if (typeScope === undefined || !(typeScope instanceof Scope)) {
    throw new Error(
      "Type scope should be presented before type alias has been met"
    );
  }
  const genericNode = getGenericNode(node);
  const localTypeScope = new Scope(Scope.BLOCK_TYPE, typeScope);
  const usedTypeScope = genericNode ? localTypeScope : typeScope;
  const genericArguments =
    genericNode &&
    genericNode.typeParameters.params.map(typeAnnotation =>
      getTypeFromTypeAnnotation({ typeAnnotation }, localTypeScope)
    );
  const type = getTypeFromTypeAnnotation(
    { typeAnnotation: node.right },
    usedTypeScope,
    false
  );
  const typeFor = genericArguments
    ? GenericType.createTypeWithName(
        node.id.name,
        typeScope,
        genericArguments,
        localTypeScope,
        type
      )
    : type;
  const typeAlias = new VariableInfo(typeFor, typeScope, new Meta(node.loc));
  typeScope.body.set(node.id.name, typeAlias);
};

const fillModuleScope = (typeGraph: ModuleScope, errors: Array<HegelError>) => {
  const typeScope = typeGraph.body.get(TYPE_SCOPE);
  if (!typeScope || !(typeScope instanceof Scope)) {
    throw new Error("Type scope is not a scope.");
  }
  return (currentNode: Node, parentNode: Node, meta?: TraverseMeta = {}) => {
    switch (currentNode.type) {
      case NODE.TYPE_ALIAS:
        addTypeAlias(currentNode, typeGraph);
        break;
      case NODE.VARIABLE_DECLARATOR:
        addVariableToGraph(
          Object.assign(currentNode, meta),
          parentNode,
          typeGraph
        );
        break;
      case NODE.OBJECT_METHOD:
      case NODE.FUNCTION_EXPRESSION:
      case NODE.ARROW_FUNCTION_EXPRESSION:
      case NODE.CLASS_DECLARATION:
      case NODE.FUNCTION_DECLARATION:
        addFunctionToTypeGraph(currentNode, parentNode, typeGraph);
        break;
      case NODE.BLOCK_STATEMENT:
        if (NODE.isFunction(parentNode)) {
          return;
        }
      case NODE.CLASS_DECLARATION:
      case NODE.CLASS_EXPRESSION:
        const scopeName = getScopeKey(currentNode);
        if (typeGraph.body.get(scopeName)) {
          return;
        }
        typeGraph.body.set(
          scopeName,
          getScopeFromNode(currentNode, parentNode, typeGraph)
        );
        break;
      case NODE.TRY_STATEMENT:
        const tryBlock = getScopeFromNode(
          currentNode.block,
          parentNode,
          typeGraph
        );
        tryBlock.throwable = [];
        typeGraph.body.set(getScopeKey(currentNode.block), tryBlock);
        if (!currentNode.handler) {
          return;
        }
        const handlerScopeKey = getScopeKey(currentNode.handler.body);
        typeGraph.body.set(
          handlerScopeKey,
          getScopeFromNode(currentNode.handler.body, parentNode, typeGraph)
        );
        if (!currentNode.handler.param) {
          return;
        }
        addVariableToGraph(
          currentNode.handler.param,
          currentNode.handler.body,
          typeGraph,
          currentNode.handler.param.name
        );
    }
  };
};

const afterFillierActions = (
  typeGraph: ModuleScope,
  errors: Array<HegelError>
) => {
  const typeScope = typeGraph.body.get(TYPE_SCOPE);
  if (!typeScope || !(typeScope instanceof Scope)) {
    throw new Error("Type scope is not a scope.");
  }
  return (
    currentNode: Node,
    parentNode: Node | Scope | ModuleScope,
    meta?: Object = {}
  ) => {
    const currentScope = getParentFromNode(currentNode, parentNode, typeGraph);
    switch (currentNode.type) {
      case NODE.VARIABLE_DECLARATOR:
        const variableInfo = findVariableInfo(currentNode.id, currentScope);
        const newTypeOrVar = addCallToTypeGraph(
          currentNode,
          typeGraph,
          currentScope
        );
        const newType =
          newTypeOrVar instanceof VariableInfo
            ? newTypeOrVar.type
            : newTypeOrVar;
        variableInfo.type =
          variableInfo.type.name === UNDEFINED_TYPE
            ? newType
            : variableInfo.type;
        break;
      case NODE.BLOCK_STATEMENT:
        if (!currentNode.catchBlock || !currentNode.catchBlock.param) {
          return;
        }
        if (currentNode.catchBlock.param.type !== NODE.IDENTIFIER) {
          throw new Error("Unsupported yet");
        }
        const errorVariable = findVariableInfo(
          currentNode.catchBlock.param,
          getParentFromNode(
            currentNode.catchBlock.param,
            currentNode.catchBlock.body,
            typeGraph
          )
        );
        errorVariable.type = inferenceErrorType(currentNode, typeGraph);
        break;
      case NODE.CALL_EXPRESSION:
      case NODE.RETURN_STATEMENT:
      case NODE.EXPRESSION_STATEMENT:
      case NODE.IF_STATEMENT:
      case NODE.WHILE_STATEMENT:
      case NODE.DO_WHILE_STATEMENT:
      case NODE.FOR_STATEMENT:
      case NODE.THROW_STATEMENT:
        addCallToTypeGraph(currentNode, typeGraph, currentScope);
        break;
      case NODE.OBJECT_METHOD:
      case NODE.FUNCTION_EXPRESSION:
      case NODE.ARROW_FUNCTION_EXPRESSION:
      case NODE.CLASS_DECLARATION:
      case NODE.FUNCTION_DECLARATION:
        const functionScope = typeGraph.body.get(getScopeKey(currentNode));
        if (!(functionScope instanceof Scope)) {
          throw new Error("Never!");
        }
        if (
          functionScope.declaration instanceof VariableInfo &&
          functionScope.declaration.type instanceof GenericType &&
          functionScope.type === Scope.FUNCTION_TYPE &&
          functionScope.declaration.type.subordinateType instanceof FunctionType
        ) {
          const { declaration } = functionScope;
          // $FlowIssue - Type refinements
          inferenceFunctionTypeByScope(functionScope, typeGraph);
          checkCalls(functionScope, typeScope, errors);
          declaration.throwable = (functionScope.throwable || []).length
            ? inferenceErrorType(currentNode, typeGraph)
            : undefined;
        }
        break;
    }
  };
};

const createModuleScope = (ast: Program): [ModuleScope, Array<HegelError>] => {
  const errors: Array<HegelError> = [];
  const result = new ModuleScope();
  const typeScope = new Scope("block", result);
  result.body.set(TYPE_SCOPE, typeScope);
  mixBaseGlobals(result);
  mixBaseOperators(result);
  try {
    traverseTree(
      ast,
      fillModuleScope(result, errors),
      afterFillierActions(result, errors)
    );
  } catch (e) {
    if (!(e instanceof HegelError)) {
      throw e;
    }
    errors.push(e);
  }
  checkCalls(result, typeScope, errors);
  return [result, errors];
};

export default createModuleScope;