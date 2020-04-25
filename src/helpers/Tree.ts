export class Tree<TBranch, TLeaf> {
    constructor(readonly rootNode: Tree.BranchNode<TBranch>) { }

    getNodeAtPath(keyPath: string[]): Tree.FilledNode<TBranch | TLeaf> {
        //Start from the root of the tree, move down each key
        let currentNode : Tree.Node<TBranch | TLeaf> = this.rootNode;

        if (keyPath.length === 0) {
            return Tree.fillNode(currentNode); //Return the root node
        }

        for (let targetKey of keyPath) {
            if (Tree.isLeaf(currentNode)) {
                break; //This node has no children; cannot continue
            }

            let currentChildren = (currentNode as Tree.BranchNode<TBranch>).getChildren();

            //Search for targetKey in currentChildren
            let foundChild = false;
            for (let child of currentChildren) {
                if (child.key === targetKey) {
                    currentNode = child;
                    foundChild = true;
                    break;
                }
            }

            if (!foundChild) {
                return null; //No child with the target key
            }
        }

        if (currentNode.key === keyPath[keyPath.length - 1]) {
            return Tree.fillNode(currentNode);
        } else {
            return null; //The path could not be fully traversed
        }
    }
}

export namespace Tree {
    export abstract class Node<T> {
        abstract readonly nodeType: 'branch' | 'leaf';
        constructor(readonly key: string, readonly value?: T) { };
    }

    export class BranchNode<T> extends Node<T> {
        readonly nodeType = 'branch';

        private childProvider: () => Node<T>[];
        constructor(key: string, value?: T, childProvider?: () => Node<any>[]) {
            super(key, value);
            if (childProvider) {
                this.childProvider = childProvider;
            } else {
                this.childProvider = () => [];
            }
        }

        getChildren() {
            return this.childProvider();
        }

        setChildProvider(provider: () => Node<T>[]) {
            this.childProvider = provider;
        }

        clearChildren() {
            this.childProvider = () => [];
        }
    }

    //AKA Edge node - does not have children
    export class LeafNode<T> extends Node<T> {
        readonly nodeType = 'leaf';
    }

    export function isBranch(node: Node<any>) : node is BranchNode<any> {
        return node.nodeType == 'branch';
    }

    export function isLeaf(node: Node<any>) : node is LeafNode<any> {
        return node.nodeType == 'leaf';
    }

    //Node with first-level children pre-fetched
    export class FilledNode<T> extends Node<T> {
        constructor(key: string, readonly nodeType: 'leaf' | 'branch', readonly children: Node<any>[], value?: T) { 
            super(key, value);
        };
    }

    export function fillNode<T>(node: Node<T>) : FilledNode<T> {
        if (isBranch(node)) {
            return new FilledNode<T>(node.key, node.nodeType, node.getChildren(), node.value);
        } else {
            return new FilledNode<T>(node.key, node.nodeType, [], node.value);
        }
    }
}