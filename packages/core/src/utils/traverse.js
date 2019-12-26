// @flow
import NODE from "./nodes";
import HegelError, { UnreachableError } from "./errors";
import type { Node, Declaration, Block, SourceLocation } from "@babel/parser";

type Tree =
  | Node
  | {
      body: Array<Node> | Node,
      kind?: ?string,
      loc: SourceLocation
    };

export type TraverseMeta = {
  kind?: ?string
};

export const compose = (fn: Function, ...fns: Array<Function>) => (
  ...args: Array<mixed>
) => fns.reduce((res, fn) => fn(res), fn(...args));


function mixBodyToArrowFunctionExpression(currentNode: Node) {
  if (
    currentNode.type !== NODE.ARROW_FUNCTION_EXPRESSION ||
    currentNode.body.type === NODE.BLOCK_STATEMENT
  ) {
    return currentNode;
  }
  currentNode.body = {
    type: NODE.BLOCK_STATEMENT,
    body: [
      {
        type: NODE.RETURN_STATEMENT,
        argument: currentNode.body,
        loc: currentNode.body.loc
      }
    ],
    loc: currentNode.body.loc
  };
  return currentNode;
}

function mixBlockForStatements(currentNode: Node) {
  if (
    currentNode.type !== NODE.IF_STATEMENT &&
    currentNode.type !== NODE.WHILE_STATEMENT &&
    currentNode.type !== NODE.FOR_STATEMENT &&
    currentNode.type !== NODE.FOR_IN_STATEMENT &&
    currentNode.type !== NODE.FOR_OF_STATEMENT
  ) {
    return currentNode;
  }
  if (
    currentNode.type === NODE.IF_STATEMENT &&
    currentNode.alternate &&
    currentNode.alternate.type !== NODE.BLOCK_STATEMENT
  ) {
    currentNode.alternate = {
      type: NODE.BLOCK_STATEMENT,
      body: [currentNode.alternate],
      loc: currentNode.alternate.loc
    };
  }
  const propertyName =
    currentNode.type === NODE.IF_STATEMENT ? "consequent" : "body";
  if (currentNode[propertyName].type === NODE.BLOCK_STATEMENT) {
    return currentNode;
  }
  currentNode[propertyName] = {
    type: NODE.BLOCK_STATEMENT,
    body: [currentNode[propertyName]],
    loc: currentNode[propertyName].loc
  };
  return currentNode;
}

function getInitFor(node) {
  switch (node.type) {
    case NODE.FOR_IN_STATEMENT:
      return { type: NODE.PURE_KEY, of: node.right };
    case NODE.FOR_OF_STATEMENT:
      return { type: NODE.PURE_VALUE, of: node.right };
    default:
      return;
  }
}

function mixDeclarationsInideForBlock(currentNode: Node) {
  if (
    currentNode.type !== NODE.FOR_IN_STATEMENT &&
    currentNode.type !== NODE.FOR_OF_STATEMENT &&
    (currentNode.type !== NODE.FOR_STATEMENT || currentNode.init === null)
  ) {
    return currentNode;
  }
  if (currentNode.body.type === NODE.EMPTY_STATEMENT) {
    currentNode.body = {
      type: NODE.BLOCK_STATEMENT,
      body: [],
      loc: currentNode.init.loc
    };
  }
  currentNode.body.body.unshift(
    currentNode.init || {
      ...currentNode.left,
      init: getInitFor(currentNode)
    }
  );
  return currentNode;
}

function mixExportInfo(currentNode: Node) {
  if (
    currentNode.type !== NODE.EXPORT_NAMED_DECLARATION &&
    currentNode.type !== NODE.EXPORT_DEFAULT_DECLARATION
  ) {
    return currentNode;
  }
  return currentNode.declaration.type !== NODE.VARIABLE_DECLARATION
    ? {
        ...currentNode.declaration,
        exportAs:
          currentNode.type === NODE.EXPORT_DEFAULT_DECLARATION
            ? "default"
            : currentNode.declaration.id.name
      }
    : {
        ...currentNode.declaration,
        declarations: currentNode.declaration.declarations.map(declaration => ({
          ...declaration,
          exportAs: declaration.id.name
        }))
      };
}

function mixTryCatchInfo(currentNode: Node) {
  if (currentNode.type !== NODE.TRY_STATEMENT) {
    return currentNode;
  }
  return {
    ...currentNode,
    block: {
      ...currentNode.block,
      catchBlock: currentNode.handler
    }
  };
}

const getBody = (currentNode: any) =>
  currentNode.body ||
  currentNode.declarations ||
  currentNode.properties ||
  [
    currentNode.block,
    currentNode.handler,
    currentNode.finalizer,
    currentNode.consequent,
    currentNode.alternate,
    currentNode.value,
    currentNode.init && currentNode.init.callee,
    currentNode.init,
    currentNode.object,
    currentNode.property,
    currentNode.left,
    currentNode.right,
    currentNode.argument,
    currentNode.expression && currentNode.expression.callee,
    currentNode.expression,
    currentNode.callee,
    ...(currentNode.elements || [])
  ].filter(Boolean);

const getNextParent = (currentNode: Tree, parentNode: ?Tree) =>
  parentNode &&
  ((NODE.isFunction(parentNode) && currentNode === parentNode.body) ||
    (NODE.isScopeCreator(parentNode) && !NODE.isScopeCreator(currentNode)))
    ? parentNode
    : currentNode;

const getCurrentNode = compose(
  mixDeclarationsInideForBlock,
  mixBodyToArrowFunctionExpression,
  mixTryCatchInfo,
  mixBlockForStatements,
  mixExportInfo
);

export type Handler = (Tree, Tree, Handler, Handler, Handler, TraverseMeta) => void | boolean;

function traverseTree(
  node: Tree,
  pre: Handler,
  middle: Handler,
  post: Handler,
  parentNode: ?Tree = null,
  meta?: TraverseMeta = {}
) {
  const currentNode = getCurrentNode(node, parentNode, meta);
  const shouldContinueTraversing = pre(currentNode, parentNode, pre, middle, post, meta);
  if (!shouldContinueTraversing) {
    return;
  }
  const body = getBody(currentNode);
  if (!body) {
    return;
  }
  const nextParent = getNextParent(currentNode, parentNode);
  if (Array.isArray(body)) {
    let i = 0;
    try {
      for (i = 0; i < body.length; i++) {
        middle(body[i], nextParent, pre, middle, post, meta);
      }
      for (i = 0; i < body.length; i++) {
        traverseTree(body[i], pre, middle, post, nextParent, {
          ...meta,
          kind: currentNode.kind
        });
      }
    } catch (e) {
      if (!(e instanceof UnreachableError)) {
        throw e;
      }
      if (i < body.length - 1) {
        throw new HegelError("Unreachable code after this line", e.loc);
      }
    }
  } else {
    traverseTree(body, pre, middle, post, nextParent, meta);
  }
  post(currentNode, parentNode, pre, middle, post, meta);
}

export default traverseTree;
