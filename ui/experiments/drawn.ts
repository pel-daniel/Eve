/// <reference path="../src/microReact.ts" />
/// <reference path="../src/api.ts" />
/// <reference path="../src/client.ts" />
/// <reference path="../src/tableEditor.ts" />
/// <reference path="../src/glossary.ts" />
/// <reference path="../experiments/layout.ts" />
module eveEditor {
  var localState = api.localState;
  var ixer = api.ixer;
  var code = api.code;
  var DEBUG = window["DEBUG"];
  // we'll keep separate stacks for each workspace
  var eventStacks = {};

  export function storeEvent(workspace, event, diffs) {
    if(!eventStacks[workspace]) {
        eventStacks[workspace] = {root: true, children: [], parent: null, diffs: null};
    }
    var eventItem = {event, diffs, children: [], parent: eventStacks[workspace], root: false};
    eventStacks[workspace].children.push(eventItem);
    eventStacks[workspace] = eventItem;
  }

  export function scaryUndoEvent(workspace): any[] {
    let eventStack = eventStacks[workspace];
    if(!eventStack.parent || !eventStack.diffs) return [];
    var old = eventStack;
    eventStacks[workspace] = old.parent;
    return api.reverseDiff(old.diffs);
  }

  export function scaryRedoEvent(workspace): any[] {
    let eventStack = eventStacks[workspace];
    if(!eventStack.children.length) return [];
    eventStacks[workspace] = eventStack.children[eventStack.children.length - 1];
    return eventStacks[workspace].diffs;
  }

  export function executeDispatch(diffs, storeEvent, sendToServer) {
    if(diffs && diffs.length) {
      ixer.handleDiffs(diffs);
      if(sendToServer) {
        if(DEBUG.DELAY) {
          setTimeout(function() {
            client.sendToServer(diffs, false);
          }, DEBUG.DELAY);
        } else {
          client.sendToServer(diffs, false);
        }
      }

    } else {
      //       console.warn("No diffs to index, skipping.");
    }

    //@TODO: since we don't have a way to determine if localState has changed, we have
    //to render anytime dispatch is called
    drawn.render();
  }
}

module drawn {

  declare var uuid;
  const localState = api.localState;
  const ixer = api.ixer;
  const code = api.code;

  //---------------------------------------------------------
  // Constants
  //---------------------------------------------------------

  const nodeWidthMultiplier = 9;
  const nodeSmallWidthMultiplier = 8;
  const nodeWidthPadding = 10;
  const nodeHeight = 18;
  const nodeHeightPadding = 3;
  const nodeWidthMin = 50;
  const nodeFilterWidthMin = 30;
  const previewWidth = 250;
  const previewHeight = 225;

  //---------------------------------------------------------
  // Utils
  //---------------------------------------------------------

   function coerceInput(input) {
        if (input.match(/^-?[\d]+$/gim)) {
            return parseInt(input);
        }
        else if (input.match(/^-?[\d]+\.[\d]+$/gim)) {
            return parseFloat(input);
        }
        else if (input === "true") {
            return true;
        }
        else if (input === "false") {
            return false;
        }
        return input;
    }

    function stopPropagation(e) {
        e.stopPropagation();
    }

    function preventDefault(e) {
        e.preventDefault();
    }

    function focusOnce(node, elem) {
        if (!node.__focused) {
            node.focus();
            node.__focused = true;
            if(elem.contentEditable && node.firstChild) {
              let range = document.createRange();
              range.setStart(node.firstChild, node.textContent.length);
              range.setEnd(node.firstChild, node.textContent.length);
              let sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            }
        }
    }

	//---------------------------------------------------------
  // Renderer
  //---------------------------------------------------------

  export var renderer = new microReact.Renderer();
  document.body.appendChild(renderer.content);
  renderer.queued = false;
  export function render() {
   if(renderer.queued === false) {
      renderer.queued = true;
      // @FIXME: why does using request animation frame cause events to stack up and the renderer to get behind?
      setTimeout(function() {
      // requestAnimationFrame(function() {
        var start = performance.now();
        var tree = root();
        var total = performance.now() - start;
        if(total > 10) {
          console.log("Slow root: " + total);
        }
        renderer.render(tree);
        renderer.queued = false;
      }, 16);
    }
  }

  window.addEventListener("resize", render);

  //---------------------------------------------------------
  // localState
  //---------------------------------------------------------

  localState.selectedNodes = {};
  localState.overlappingNodes = {};
  localState.drawnUiActiveId = false;
  localState.errors = [];
  localState.selectedItems = {};
  localState.tableEntry = {};
  localState.saves = JSON.parse(localStorage.getItem("saves") || "[]");

  var fieldToEntity = {}

  export var entities = [];
  for(var field in fieldToEntity) {
    var ent = fieldToEntity[field];
    if (entities.indexOf(ent) === -1) {
      entities.push(ent);
    }
  }

  export var positions = {}

  function loadPositions() {
    var loadedPositions = ixer.select("editor node position", {});
    for(var pos of loadedPositions) {
      positions[pos["editor node position: node"]] = {top: pos["editor node position: y"], left: pos["editor node position: x"]};
    }
  }

  //---------------------------------------------------------
  // Node helpers
  //---------------------------------------------------------

  function findNodesIntersecting(currentNode, nodes, nodeLookup) {
    let currentNodePosition = nodeDisplayInfo(currentNode);
    let overlaps = [];
    if (currentNodePosition.left === undefined || currentNodePosition.top === undefined) { return overlaps; }
    for (let node of nodes) {
      if (node.id === currentNode.id) continue;
      let nodePosition = nodeDisplayInfo(nodeLookup[node.id]);

      if (nodePosition.left !== undefined && nodePosition.top !== undefined &&
        currentNodePosition.right > nodePosition.left &&
        currentNodePosition.left < nodePosition.right &&
        currentNodePosition.bottom > nodePosition.top &&
        currentNodePosition.top < nodePosition.bottom) {
        overlaps.push(node.id);
      }
    }
    return overlaps;
  }

  function intersectionAction(nodeA, nodeB): any {
    //given two nodes, we check to see if their intersection should cause something to happen
    //e.g. two attributes intersecting would signal joining them
    if(nodeA.type === "attribute" && nodeB.type === "attribute") {
      return "joinNodes";
    }
    return false;
  }

  function actionableIntersections(viewId, currentNodeId, radius = 30) {
    let {nodeLookup, nodes} = viewToEntityInfo(ixer.selectOne("view", {view: viewId}));
    let overlaps = findNodesIntersecting(nodeLookup[currentNodeId], nodes, nodeLookup);
    let curNode = nodeLookup[currentNodeId];
    let actions = [];
    let lookup = {};
    for(let overlappingId of overlaps) {
      let overlappingNode = nodeLookup[overlappingId];
      let action = intersectionAction(curNode, overlappingNode);
      if(action) {
        let info = {node: curNode, target: overlappingNode, action};
        actions.push(info);
        lookup[overlappingId] = info;
      }
    }
    return {actions, lookup};
  }

  function getNodesInRectangle(viewId, box) {
    let {nodes} = viewToEntityInfo(ixer.selectOne("view", {view: viewId}));
    let boxLeft = Math.min(box.start.x, box.end.x);
    let boxRight = Math.max(box.start.x, box.end.x)
    let boxTop = Math.min(box.start.y, box.end.y);
    let boxBottom = Math.max(box.start.y, box.end.y);
    return nodes.map((node) => {
      return {node, displayInfo: nodeDisplayInfo(node)};
    }).filter((info) => {
      let {node, displayInfo} = info;
      if(displayInfo.left === undefined || displayInfo.top === undefined) { return false; }
      let overlapLeft = Math.max(boxLeft, displayInfo.left);
      let overlapRight = Math.min(boxRight, displayInfo.right);
      let overlapTop = Math.max(boxTop, displayInfo.top);
      let overlapBottom = Math.min(boxBottom, displayInfo.bottom);
      return overlapLeft < overlapRight && overlapTop < overlapBottom;
    });
  }

  function nodesToRectangle(nodes) {
    let top = Infinity;
    let left = Infinity;
    let bottom = -Infinity;
    let right = -Infinity;
    for(var node of nodes) {
      let info = nodeDisplayInfo(node);
      if(info.left === undefined || info.top === undefined) { continue; }
      if(info.left < left) left = info.left;
      if(info.right > right) right = info.right;
      if(info.top < top) top = info.top;
      if(info.bottom > bottom) bottom = info.bottom;
    }
    return {top, left, right, bottom, width: right - left, height: bottom - top};
  }

  //---------------------------------------------------------
  // AST helpers
  //---------------------------------------------------------

  function joinedBindingsFromSource(sourceId) {
    let joined = [];
    let bindings = ixer.select("binding", {source: sourceId});
    for(let binding of bindings) {
      let variableId = binding["binding: variable"];
      if(ixer.select("binding", {variable: variableId}).length > 1
         || ixer.select("ordinal binding", {variable: variableId}).length
         || ixer.select("constant binding", {variable: variableId}).length) {
        joined.push(binding);
      }
    }
    return joined;
  }

  function removeVariable(variableId) {
    let diffs = [];
    diffs.push(api.remove("variable", {variable: variableId}));
    diffs.push(api.remove("constant binding", {variable: variableId}));
    // we need to remove any bindings to this variable
    diffs.push(api.remove("binding", {variable: variableId}));
    diffs.push(api.remove("ordinal binding", {variable: variableId}));
    // we also need to remove any fields and selects that pull from the variable
    let selects = ixer.select("select", { variable: variableId });
    for(let select of selects) {
      let fieldId = select["select: field"];
      diffs.push(api.remove("field", { field: fieldId}));
      diffs.push(api.remove("select", { variable: variableId }));
    }
    return diffs;
  }

  function removeSource(sourceId) {
    var diffs = [
      api.remove("source", {source: sourceId}),
      api.remove("binding", {source: sourceId})
    ]
    let bindings = ixer.select("binding", {source: sourceId});
    for(let binding of bindings) {
      let variableId = binding["binding: variable"];
      // determine if this is the only binding for this variable
      let allVariableBindings = ixer.select("binding", {variable: variableId});
      let singleBinding = allVariableBindings.length === 1;
      // if this variable is only bound to this field, then we need to remove it
      if(singleBinding) {
        diffs.push.apply(diffs, removeVariable(variableId));
      } else {
        // we need to check if the remaining bindings are all inputs, if so we
        // bind it to a constant to ensure the code remains valid
        let needsConstant = true;
        let input;
        for(let variableBinding of allVariableBindings) {
           if(variableBinding === binding) continue;
           let fieldId = variableBinding["binding: field"];
           let kind = ixer.selectOne("field", {field: fieldId})["field: kind"];
           if(kind === "output") {
             needsConstant = false;
             break;
           } else {
             input = variableBinding;
           }
        }
        if(needsConstant) {
           let fieldId = input["binding: field"];
           let sourceViewId = ixer.selectOne("source", {source: input["binding: source"]})["source: source view"];
           diffs.push(api.insert("constant binding", {variable: variableId, value: api.newPrimitiveDefaults[sourceViewId][fieldId]}));
        }
      }
    }
    let ordinal = ixer.selectOne("ordinal binding", {source: sourceId});
    if(ordinal) {
       diffs.push.apply(diffs, removeVariable(ordinal["ordinal binding: variable"]));
    }
    return diffs;
  }

  function addSourceFieldVariable(itemId, sourceViewId, sourceId, fieldId) {
    let diffs = [];
    let kind;
    // check if we're adding an ordinal
    if(fieldId === "ordinal") {
      kind = "ordinal";
    } else {
      kind = ixer.selectOne("field", {field: fieldId})["field: kind"];
    }
    // add a variable
    let variableId = uuid();
    diffs.push(api.insert("variable", {view: itemId, variable: variableId}));
    if(kind === "ordinal") {
      // create an ordinal binding
      diffs.push(api.insert("ordinal binding", {variable: variableId, source: sourceId}));
    } else {
      // bind the field to it
      diffs.push(api.insert("binding", {variable: variableId, source: sourceId, field: fieldId}));
    }
    if(kind === "output" || kind === "ordinal") {
      // select the field
      diffs.push.apply(diffs, dispatch("addSelectToQuery", {viewId: itemId, variableId: variableId, name: code.name(fieldId) || fieldId}, true));
    } else {
      // otherwise we're an input field and we need to add a default constant value
      diffs.push(api.insert("constant binding", {variable: variableId, value: api.newPrimitiveDefaults[sourceViewId][fieldId]}));
    }
    return diffs;
  }

  //---------------------------------------------------------
  // Dispatch
  //---------------------------------------------------------

  export function dispatch(event, info, rentrant?) {
    //console.log("dispatch[" + event + "]", info);
    var rerender = true;
    var diffs = [];
    var commands = [];
    var storeEvent = true;
    switch(event) {
      //---------------------------------------------------------
      // Node selection
      //---------------------------------------------------------
      case "selectNode":
        var node = info.node;
        //if this node is already in the selection, we should ignore this
        if(localState.selectedNodes[node.id]) return;
        //if shift isn't pressed, then we need to clear the current selection
        if(!info.shiftKey) {
          dispatch("clearSelection", {}, true);
        }
        localState.selectedNodes[node.id] = node;
        //build a query with the selected things in it
      break;
      case "clearSelection":
        // diffs.push(api.remove("view", api.retrieve("view", {view: localState.selectedViewId})));
        localState.selectedNodes = {};
        localState.selectedViewId = uuid();
      break;
      case "removeSelection":
        var removedSources = {};
        for(let nodeId in localState.selectedNodes) {
          let node = localState.selectedNodes[nodeId];
          if(node.type === "relationship") {
            removedSources[node.id] = true;
            diffs.push.apply(diffs, removeSource(node.id));
          } else if (node.type === "primitive") {
            removedSources[node.sourceId] = true;
            diffs.push.apply(diffs, removeSource(node.sourceId));
          }
        }
        // we need to check for any variables that got orphaned by removing all the given sources
        for(let variable of ixer.select("variable", {view: localState.drawnUiActiveId})) {
          let variableId = variable["variable: variable"];
          let bindings = ixer.select("binding", {variable: variableId});
          let shouldRemove = true;
          for(let binding of bindings) {
            if(!removedSources[binding["binding: source"]]) {
              shouldRemove = false;
              break;
            }
          }
          if(shouldRemove) {
            diffs.push.apply(diffs, removeVariable(variableId));
          }
        }
        dispatch("clearSelection", {}, true);
      break;
      case "startBoxSelection":
        //if shift isn't pressed, then we need to clear the current selection
        if(!info.shiftKey) {
          dispatch("clearSelection", {}, true);
        }
        localState.selecting = true;
        localState.boxSelection = {start: info.coords};
      break;
      case "continueBoxSelection":
        if(!localState.selecting) return;
        localState.boxSelection.end = info;
      break;
      case "endBoxSelection":
        if(localState.boxSelection && localState.boxSelection.end) {
          var boxSelectedNodes = getNodesInRectangle(localState.drawnUiActiveId, localState.boxSelection);
          boxSelectedNodes.forEach((info) => {
            let {node} = info;
            localState.selectedNodes[node.id] = node;
          });
        }
        localState.selecting = false;
        localState.boxSelection = false;
      break;
      //---------------------------------------------------------
      // Node positioning
      //---------------------------------------------------------
      case "setDragOffset":
        localState.dragOffsetX = info.x;
        localState.dragOffsetY = info.y;
      break;
      case "setNodePosition":
        var originalPosition = positions[info.node.id];
        var offsetLeft = info.pos.left - originalPosition.left;
        var offsetTop = info.pos.top - originalPosition.top;
        var selectionSize = 0;
        for(let nodeId in localState.selectedNodes) {
          let node = localState.selectedNodes[nodeId];
          let prevPosition = positions[node.id];
          positions[node.id] = {left: prevPosition.left + offsetLeft, top: prevPosition.top + offsetTop};
          selectionSize++;
        }
        // if we have only one thing selected we need to check for overlaps to show potential actions that
        // could take place
        if(selectionSize === 1) {
          localState.overlappingNodes = actionableIntersections(localState.drawnUiActiveId, info.node.id).lookup;
        } else {
          localState.overlappingNodes = {};
        }
      break;
      case "finalNodePosition":
       var selectionSize = 0;
       for(let nodeId in localState.selectedNodes) {
          let node = localState.selectedNodes[nodeId];
          let currentPos = positions[node.id];
          diffs.push(api.insert("editor node position", {node: nodeId, x: currentPos.left, y: currentPos.top}),
                     api.remove("editor node position", {node: nodeId}));
          selectionSize++;
        }
        // @TODO: Check for potential overlap with other nodes
        if(selectionSize === 1) {
          let {lookup, actions} = actionableIntersections(localState.drawnUiActiveId, info.node.id);
          for(let action of actions) {
            diffs.push.apply(diffs, dispatch(action.action, action, true));
          }
        }
      break;
      case "initializeNodePosition":
        var node = info.node;
        var currentPos = positions[node.id];
        diffs.push(api.insert("editor node position", {node: node.id, x: currentPos.left, y: currentPos.top}),
                   api.remove("editor node position", {node: node.id}));
      break;
      //---------------------------------------------------------
      // Navigation
      //---------------------------------------------------------
      case "openRelationship":
        localState.drawnUiActiveId = info.node.source["source: source view"];
        diffs = dispatch("clearSelection", {}, true);
      break;
      case "openItem":
        localState.drawnUiActiveId = info.itemId;
        // store the current search information so that when we return to the selector
        // we can make sure it's how you left it even if you do searches in the editor
        localState.selectorSearchingFor = localState.searchingFor;
        localState.selectorSearchResults = localState.searchResults;
        // if this item is a table, we should setup the initial table entry
        var kind = ixer.selectOne("view", {view: info.itemId})["view: kind"];
        if(kind === "table") {
          diffs.push.apply(diffs, dispatch("newTableEntry", {}, true));
        }
      break;
      case "gotoItemSelector":
        // clear selection when leaving a workspace to ensure it doesn't end up taking effect in the
        // next one you go to.
        diffs = dispatch("clearSelection", {}, true);
        localState.drawnUiActiveId = false;
        // restore the previous search state so that the selector is how you left it
        localState.searchingFor = localState.selectorSearchingFor;
        localState.searchResults = localState.selectorSearchResults;
      break;
      case "selectItem":
        if(!info.shiftKey) {
          localState.selectedItems = {};
        } else if(info.shiftKey && localState.selectedItems[info.itemId]) {
          // if this item is already selected and we click it again with the shiftKey
          // then we need to deselect it
          delete localState.selectedItems[info.itemId];
          break;
        }
        console.log("select", info.itemId);
        localState.selectedItems[info.itemId] = true;
      break;
      case "clearSelectedItems":
        localState.selectedItems = {};
      break;
      case "removeSelectedItems":
        // @TODO: implement item removal
        console.error("TODO: implement item removal");
      break;
      //---------------------------------------------------------
      // Query building
      //---------------------------------------------------------
      case "createNewItem":
        var newId = uuid();
        localState.drawnUiActiveId = newId;
        var tag;
        if(info.kind === "table") {
          tag = [{tag: "editor"}];
          diffs.push.apply(diffs, dispatch("addFieldToTable", {tableId: newId}, true));
        }
        diffs.push(api.insert("view", {view: newId, kind: info.kind, dependents: {"display name": {name: info.name}, tag}}));
        diffs.push.apply(diffs, dispatch("hideTooltip", {}, true));

      break;
      case "addViewAndMaybeJoin":
        var sourceId = uuid();
        var itemId = localState.drawnUiActiveId;
        diffs = [
          api.insert("source", {view: itemId, source: sourceId, "source view": info.viewId})
        ];
        // if there's a selection, we want to try and join on those nodes if possible
        // so that we don't produce product joins all the time
        var potentialJoinNodes = {};
        for(let selectedId in localState.selectedNodes) {
          let node = localState.selectedNodes[selectedId];
          // we can only join on attributes
          if(node.type === "attribute") {
            potentialJoinNodes[node.name] = node;
          }
        }
        // add variables for all the fields of this view
        var sourceView = ixer.selectOne("view", {view: info.viewId});
        ixer.select("field", {view: info.viewId}).forEach(function(field) {
            let fieldId = field["field: field"];
            let name = code.name(fieldId);
            // check if we should try to join this field to one of the potential join nodes
            if(potentialJoinNodes[name]) {
              // if we're going to join, we just need a binding to this node
              diffs.push(api.insert("binding", {source: sourceId, field: fieldId, variable: potentialJoinNodes[name].variable}));
            } else {
              // otherwise we need to create a variable for this field
              diffs.push.apply(diffs, addSourceFieldVariable(itemId, info.viewId, sourceId, fieldId));
            }
        });
      break;
      case "joinNodes":
        var {target, node} = info;
        if(!node || !target) throw new Error("Trying to join at least one non-existent node");
        var variableId = node.variable;
        var variableIdToRemove = target.variable;

        // transfer all the bindings to the new variable
        var oldBindings = ixer.select("binding", {variable: variableIdToRemove});
        for(let binding of oldBindings) {
          let sourceId = binding["binding: source"];
          let fieldId = binding["binding: field"];
          diffs.push(api.insert("binding", {variable: variableId, source: sourceId, field: fieldId}));
        }
        // check for an ordinal binding and move it over if it exists
        var ordinalBinding = ixer.selectOne("ordinal binding", {variable: variableIdToRemove});
        if(ordinalBinding) {
          diffs.push(api.insert("ordinal binding", {variable: variableId, source: ordinalBinding["ordinal binding: source"]}));
        }

        // remove the old variable
        diffs.push.apply(diffs, removeVariable(variableIdToRemove));

        //if either of these nodes are a primitive input, then we should remove any constant
        //constraint that was on there.
        var primitiveNode;
        var nonPrimitiveNode;
        if(target.isInput) {
          primitiveNode = target;
          nonPrimitiveNode = node;
        } else if(node.isInput) {
          primitiveNode = node;
          nonPrimitiveNode = target;
        }
        if(primitiveNode) {
          // ensure that these nodes can act as inputs:
          // if it's a vector input this has to be a non-grouped, sourceChunked attribute
          // if it's a scalar input this has to be either grouped or a non-sourceChunked attribute
          if(primitiveNode.inputKind === "vector input" && (nonPrimitiveNode.grouped || !nonPrimitiveNode.sourceChunked)) {
            //we do this as a normal dispatch as we want to bail out in the error case.
            return dispatch("setError", {errorText: "Aggregates require columns as input, try selecting the source and chunking it."});
          } else if(primitiveNode.inputKind === "scalar input" && !nonPrimitiveNode.grouped && nonPrimitiveNode.sourceChunked) {
            //we do this as a normal dispatch as we want to bail out in the error case.
            return dispatch("setError", {errorText: "Normal functions can't take columns as input, you could try unchunking the source or grouping this field."});
          }
          diffs.push(api.remove("constant binding", {variable: primitiveNode.variable}));
        }
        diffs.push.apply(diffs, dispatch("clearSelection", info, true));
      break;
      case "joinSelection":
        let ids = Object.keys(localState.selectedNodes);
        let root = localState.selectedNodes[ids[0]];
        for(let nodeId of ids.slice(1)) {
          let node = localState.selectedNodes[nodeId];
          diffs.push.apply(diffs, dispatch("joinNodes", {node, target: root}, true));
        }
      break;
      case "unjoinNodes":
        var itemId = localState.drawnUiActiveId;
        var variableIdToRemove = info.variableId;
        var oldBindings = ixer.select("binding", {variable: variableIdToRemove});
         // push all the bindings onto their own variables, skipping the first as that one can reuse
         // the current variable
        for(let binding of oldBindings.slice(1)) {
          let sourceId = binding["binding: source"];
          let fieldId = binding["binding: field"];
          let sourceViewId = ixer.selectOne("source", {source: sourceId})["source: source view"];
          diffs.push.apply(diffs, addSourceFieldVariable(itemId, sourceViewId, sourceId, fieldId));
          diffs.push(api.remove("binding", {variable: variableIdToRemove, source: sourceId, field: fieldId}));
        }
        // check for an ordinal binding and create a new variable for it if it exists
        var ordinalBinding = ixer.selectOne("ordinal binding", {variable: variableIdToRemove});
        if(ordinalBinding) {
          diffs.push.apply(diffs, addSourceFieldVariable(itemId, null, ordinalBinding["ordinal binding: source"], "ordinal"));
          diffs.push(api.remove("ordinal binding", {variable: variableIdToRemove}));
        }
        // we have to check to make sure that if the original binding represents an input it gets a default
        // added to it to prevent the server from crashing
        var fieldId = oldBindings[0]["binding: field"];
        var kind = ixer.selectOne("field", {field: fieldId})["field: kind"];
        if(kind !== "output") {
          let sourceViewId = ixer.selectOne("source", {source: oldBindings[0]["binding: source"]})["source: source view"];
          diffs.push(api.insert("constant binding", {variable: variableIdToRemove, value: api.newPrimitiveDefaults[sourceViewId][fieldId]}));
        }

      break;
      case "removeSelectFromQuery":
        var selects = ixer.select("select", {variable: info.variableId}) || [];
        for(let select of selects) {
          let fieldId = select["select: field"];
          diffs.push(api.remove("field", {field: fieldId}));
        }
        diffs.push(api.remove("select", {variable: info.variableId}));
      break;
      case "addSelectToQuery":
        var name = info.name;
        var fields = ixer.select("field", {view: info.viewId}) || [];
        var neueField = api.insert("field", {view: info.viewId, kind: "output", dependents: {
          "display name": {name: name},
          "display order": {priority: -fields.length}
        }});
        var fieldId = neueField.content.field;

        // check to make sure this isn't only a negated attribute
        var onlyNegated = !info.allowNegated;
        var bindings = ixer.select("binding", {variable: info.variableId});
        for(let binding of bindings) {
          let sourceId = binding["binding: source"];
          if(!ixer.selectOne("negated source", {source: sourceId})) {
            onlyNegated = false;
          }
        }
        if(bindings.length && onlyNegated) {
          return dispatch("setError", {errorText: "Attributes that belong to a negated source that aren't joined with something else, can't be selected since they represent the absence of a value."});
        }

        diffs = [
          neueField,
          api.insert("select", {field: fieldId, variable: info.variableId})
        ];
      break;
      case "selectSelection":
        for(let nodeId in localState.selectedNodes) {
          let node = localState.selectedNodes[nodeId];
          diffs.push.apply(diffs, dispatch("addSelectToQuery", {variableId: node.variable, name: node.name, viewId: localState.drawnUiActiveId}, true));
        }
      break;
      case "unselectSelection":
        for(let nodeId in localState.selectedNodes) {
          let node = localState.selectedNodes[nodeId];
          diffs.push.apply(diffs, dispatch("removeSelectFromQuery", {variableId: node.variable, viewId: localState.drawnUiActiveId}, true));
        }
      break;
      case "rename":
        if(info.value === ixer.selectOne("display name", {id: info.renameId})["display name: name"]) return;
        diffs.push(api.insert("display name", {id: info.renameId, name: info.value}),
                   api.remove("display name", {id: info.renameId}));
      break;
      case "setQueryDescription":
        var prevDescription = ixer.selectOne("view description", {view: info.viewId});
        if(prevDescription && info.value === prevDescription["view description: description"]) return;
        diffs.push(api.insert("view description", {view: info.viewId, description: info.value}),
                   api.remove("view description", {view: info.viewId}));
      break;
      case "addFilter":
        var variableId = info.node.variable;
        diffs.push(api.insert("constant binding", {variable: variableId, value: ""}));
        dispatch("modifyFilter", info, true);
      break;
      case "modifyFilter":
        localState.modifyingFilterNodeId = info.node.id;
      break;
      case "removeFilter":
        var variableId = info.node.variable;
        diffs.push(api.remove("constant binding", {variable: variableId}));
      break;
      case "stopModifyingFilter":
        //insert a constant
        var variableId = info.node.variable;
        diffs.push(api.remove("constant binding", {variable: variableId}));
        diffs.push(api.insert("constant binding", {variable: variableId, value: info.value}));
        localState.modifyingFilterNodeId = undefined;
      break;
      case "chunkSource":
        var sourceId = info.node.source["source: source"];
        diffs.push(api.insert("chunked source", {source: sourceId}));
        // we need to group any fields that are joined to ensure the join continues to do what you'd expect
        for(let binding of joinedBindingsFromSource(sourceId)) {
          let fieldId = binding["binding: field"];
          diffs.push(api.insert("grouped field", {source: sourceId, field: fieldId}));
        }
      break;
      case "unchunkSource":
        var sourceId = info.node.source["source: source"];
        diffs.push(api.remove("chunked source", {source: sourceId}));
        // when you unchunk, we should ungroup the fields that we grouped when chunking.
        for(let binding of joinedBindingsFromSource(sourceId)) {
          console.log(binding);
          let fieldId = binding["binding: field"];
          let variableId = binding["binding: variable"];
          // We have to check for an aggregate binding, as unchunking will cause the
          // vector binding to error out. If there is an aggregate binding, then we have to bail
          // out of unchunking.
          for(let variableBinding of ixer.select("binding", {variable: variableId})) {
            let fieldKind = ixer.selectOne("field", {field: variableBinding["binding: field"]})["field: kind"];
            console.log("fieldKind", fieldKind);
            if(fieldKind === "vector input") {
              return dispatch("setError", {errorText: "Cannot unchunk this source because it's bound to an aggregate, which requires a column."});
            }
          }
          diffs.push(api.remove("grouped field", {source: sourceId, field: fieldId}));
        }
      break;
      case "addOrdinal":
        var sourceId = info.node.source["source: source"];
        // @TODO: we need a way to create a variable for this to really work
        var fields = ixer.select("field", {view: info.viewId}) || [];
        var neueField = api.insert("field", {view: info.viewId, kind: "output", dependents: {
          "display name": {name: "ordinal"},
          "display order": {priority: -fields.length}
        }});
        var fieldId = neueField.content.field;
        var variableId = uuid();
        diffs.push(
          neueField,
          // create a variable
          api.insert("variable", {view: info.viewId, variable: variableId}),
          // bind the ordinal to it
          api.insert("ordinal binding", {source: sourceId, variable: variableId}),
          // select the variable into the created field
          api.insert("select", {variable: variableId, field: fieldId})
        );
      break;
      case "removeOrdinal":
        var sourceId = info.node.source["source: source"];
        var variableId = ixer.selectOne("ordinal binding", {source: sourceId})["ordinal binding: variable"];
        diffs = removeVariable(variableId);
      break;
      case "groupAttribute":
        var variableId = info.node.variable;
        var bindings = ixer.select("binding", {variable: variableId});
        if(bindings.length > 1) {
          //we do this as a normal dispatch as we want to bail out in the error case.
          return dispatch("setError", {errorText: "Cannot group an attribute that has multiple bindings, not sure what to do."});
          return;
        }
        var sourceId = bindings[0]["binding: source"];
        var fieldId = bindings[0]["binding: field"];
        diffs.push(api.insert("grouped field", {source: sourceId, field: fieldId}));
      break;
      case "ungroupAttribute":
        var variableId = info.node.variable;
        var bindings = ixer.select("binding", {variable: variableId});
        if(bindings.length > 1) {
          //we do this as a normal dispatch as we want to bail out in the error case.
          return dispatch("setError", {errorText: "Cannot group an attribute that has multiple bindings, not sure what to do."});
        }
        var sourceId = bindings[0]["binding: source"];
        var fieldId = bindings[0]["binding: field"];
        diffs.push(api.remove("grouped field", {source: sourceId, field: fieldId}));
      break;
      case "negateSource":
        diffs.push(api.insert("negated source", {source: info.sourceId}));
        // you can't select anything from a negated source, so if there are no joins on a variable this
        // source uses we need to deselect it
        for(let binding of ixer.select("binding", {source: info.sourceId})) {
          let variableId = binding["binding: variable"];
          if(ixer.select("binding", {variable: variableId}).length === 1) {
            diffs.push.apply(diffs, dispatch("removeSelectFromQuery", {variableId: variableId, viewId: localState.drawnUiActiveId}, true));
          }
        }
      break;
      case "unnegateSource":
        diffs.push(api.remove("negated source", {source: info.sourceId}));
        // since we removed all your selects when you negated the source, let's re-select them
        var sourceViewId = ixer.selectOne("source", {source: info.sourceId})["source: source view"];
        ixer.select("field", {view: sourceViewId}).forEach(function(field) {
            let fieldId = field["field: field"];
            let binding = ixer.selectOne("binding", {source: info.sourceId, field: fieldId});
            let bindingVariableId = binding["binding: variable"];
            if(!ixer.selectOne("select", {variable: bindingVariableId})) {
              diffs.push.apply(diffs, dispatch("addSelectToQuery", {variableId: bindingVariableId, name: code.name(fieldId), viewId: localState.drawnUiActiveId, allowNegated: true}, true));
            }
        });
      break;
      //---------------------------------------------------------
      // sorting
      //---------------------------------------------------------
      case "startSort":
        var {sourceId} = info;
        localState.sorting = info;
        // if we haven't created sort fields for this before, then we create them in the
        // order that the fields of the source view are displayed in
        if(!ixer.selectOne("sorted field", {source: sourceId})) {
          let sourceViewId = ixer.selectOne("source", {source: sourceId})["source: source view"];
          let fieldIds = ixer.getFields(sourceViewId);
          let viewId = localState.drawnUiActiveId;
          fieldIds.forEach((fieldId, ix) => {
            diffs.push(api.insert("sorted field", {source: sourceId, ix, field: fieldId, direction: "ascending"}));
          })
        }
        var tooltip:any = {
          x: info.x,
          y: info.y,
          content: sorter,
          persistent: true,
          stopPersisting: stopSort,
        };
        dispatch("showTooltip", tooltip, true);
      break;
      case "stopSort":
        localState.sorting = false;
        dispatch("hideTooltip", {}, true);
      break;
      case "moveSortField":
        var {from, to, sourceId} = info;
        // if we haven't actually moved, then we just ignore the drop.
        if(from === to) break;
        // grab all the fields and get them in their current order
        var sorted = ixer.select("sorted field", {source: sourceId});
        sorted.sort((a, b) => {
          return a["sorted field: ix"] - b["sorted field: ix"];
        });
        // now update the orders based on inserting the moved item in its new location
        var viewId = localState.drawnUiActiveId;
        var updatedIx = 0;
        sorted.forEach((sort, ix) => {
          // we have to keep track of how far ahead we need to move, which depends on if
          // we insert to the left or right of the index we're moving to.
          let advanceBy = 1;
          // if this is the item we're moving, skip it
          if(ix === from) return;
          // if this is the item we're moving to, then we need to place it here
          if(ix === to) {
            let movedIx;
            // if we're moving from a greater location to a lesser on, we want to insert
            // to the left, which means we take the current updatedIndex, and the item that's
            // currently there will get bumped up one.
            if(from > to) {
              movedIx = updatedIx;
              updatedIx++;
            // if we're move from a lesser location to a greater one, we want to insert to the
            // right of it, which means we leave the current updatedIx alone and we take the index
            // after that. That means we need to advance the updatedIx by two, once for the moved item
            // and once for the item already at this index.
            } else {
              // go to the right
              movedIx = updatedIx + 1;
              advanceBy = 2;
            }
            let moved = sorted[from];
            // replace this field
            diffs.push(api.remove("sorted field", {source: sourceId, ix: moved["sorted field: ix"], field: moved["sorted field: field"], direction: moved["sorted field: direction"]}))
            diffs.push(api.insert("sorted field", {source: sourceId, ix: movedIx, field: moved["sorted field: field"], direction: moved["sorted field: direction"]}))
          }
          // we only replace this field if its index has actually changed
          if(sort["sorted field: ix"] !== updatedIx) {
            diffs.push(api.remove("sorted field", {source: sourceId, ix: sort["sorted field: ix"], field: sort["sorted field: field"], direction: sort["sorted field: direction"]}))
            diffs.push(api.insert("sorted field", {source: sourceId, ix: updatedIx, field: sort["sorted field: field"], direction: sort["sorted field: direction"]}))
          }
          updatedIx += advanceBy;
        });
      break;
      case "toggleSortDirection":
        var sortedField = ixer.selectOne("sorted field", {source: info.sourceId, field: info.fieldId});
        diffs.push(api.remove("sorted field", {source: info.sourceId, field: info.fieldId}));
        var direction = sortedField["sorted field: direction"] === "ascending" ? "descending" : "ascending";
        diffs.push(api.insert("sorted field", {source: info.sourceId, field: info.fieldId, ix: sortedField["sorted field: ix"], direction}))
      break;
      //---------------------------------------------------------
      // Errors
      //---------------------------------------------------------
      case "setError":
        var errorId = localState.errors.length;
        var newError: any = {text: info.errorText, time: api.now(), id: errorId};
        newError.errorTimeout = setTimeout(() => dispatch("fadeError", {errorId}), 2000);
        localState.errors.push(newError);
      break;
      case "fadeError":
        var errorId = info.errorId;
        var currentError = localState.errors[errorId];
        currentError.fading = true;
        currentError.errorTimeout = setTimeout(() => dispatch("clearError", {errorId: info.errorId}), 1000);
      break;
      case "clearError":
        // localState.errors = false;
      break;
      //---------------------------------------------------------
      // search
      //---------------------------------------------------------
      case "updateSearch":
        localState.searchingFor = info.value;
        localState.searchResults = searchResultsFor(info.value);
      break;
      case "startSearching":
        localState.searching = true;
        var searchValue = info.value || "";
        // when we start searching, lets check if there are attributes selected and if there
        // are, go ahead and add filters to our search for them. This makes it really easy to
        // figure out what you can join those attributes on
        for(let nodeId in localState.selectedNodes) {
          let node = localState.selectedNodes[nodeId];
          if(node.type === "attribute") {
            searchValue += `[field: ${node.name}] `;
          }
        }
        diffs.push.apply(diffs, dispatch("updateSearch", {value: searchValue}, true));
      break;
      case "stopSearching":
        localState.searching = false;
      break;
      case "handleSearchKey":
        if(info.keyCode === api.KEYS.ENTER) {
          // execute whatever the first result's action is
          let currentSearchGroup = localState.searchResults[0];
          if(currentSearchGroup && currentSearchGroup.results.length) {
            let results = currentSearchGroup.results;
            currentSearchGroup.onSelect(null, {result: currentSearchGroup.results[results.length - 1]});
          }
          diffs.push.apply(diffs, dispatch("stopSearching", {}, true));
        } else if(info.keyCode === api.KEYS.ESC) {
          localState.searchingFor = "";
          localState.searchResults = false;
          diffs.push.apply(diffs, dispatch("stopSearching", {}, true));
        } else if(info.keyCode === api.KEYS.F && (info.ctrlKey || info.metaKey)) {
          diffs.push.apply(diffs, dispatch("stopSearching", {}, true));
          info.e.preventDefault();
        }
      break;
      //---------------------------------------------------------
      // Tables
      //---------------------------------------------------------
      case "newTableEntry":
        var entry = {};
        var fields:any[] = ixer.getFields(localState.drawnUiActiveId);
        for(let fieldId of fields) {
          entry[fieldId] = "";
        }
        localState.tableEntry = entry;
        localState.selectedTableEntry = false;
        localState.focusedTableEntryField = fields[0];
      break;
      case "deleteTableEntry":
        var row = localState.tableEntry;
        var tableId = localState.drawnUiActiveId;
        // if the row is not empty, remove it. Otherwise we'd remove every
        // value in the table and be sad :(
        if(Object.keys(row).length) {
          diffs.push(api.remove(tableId, row, undefined, true));
        }
        diffs.push.apply(diffs, dispatch("newTableEntry", {}, true));
      break;
      case "selectTableEntry":
        localState.tableEntry = api.clone(info.row);
        localState.selectedTableEntry = info.row;
        localState.focusedTableEntryField = info.fieldId;
      break;
      case "addFieldToTable":
        var tableId = info.tableId || localState.drawnUiActiveId;
        var fields = ixer.select("field", {view: tableId}) || [];
        var neueField = api.insert("field", {view: tableId, kind: "output", dependents: {
          "display name": {name: `Field ${api.alphabet[fields.length]}`},
          "display order": {priority: -fields.length}
        }});
        diffs.push(neueField);
      break;
      case "removeFieldFromTable":
        // we remove whatever field is currently active in the form
        if(localState.activeTableEntryField) {
          diffs.push(api.remove("field", {field: localState.activeTableEntryField}));
        }
      break;
      case "activeTableEntryField":
        // this tracks the focus state of form fields for removal
        localState.activeTableEntryField = info.fieldId;
      break;
      case "clearActiveTableEntryField":
        // @HACK: because blur happens before a click on remove would get registered,
        // we have to wait to clear activeTableEntry to give the click time to go through
        setTimeout(function() {
          if(localState.activeTableEntryField === info.fieldId) {
            dispatch("forceClearActiveTableEntryField", info, true);
          }
        }, 150);
      break;
      case "forceClearActiveTableEntryField":
        localState.activeTableEntryField = false;
      break;
      case "focusTableEntryField":
        localState.focusedTableEntryField = false;
      break;
      case "submitTableEntry":
        var row = localState.tableEntry;
        var tableId = localState.drawnUiActiveId;
        diffs.push(api.insert(tableId, row, undefined, true));
        // if there's a selectedTableEntry then this is an edit and we should
        // remove the old row
        if(localState.selectedTableEntry) {
          diffs.push(api.remove(tableId, localState.selectedTableEntry, undefined, true));
        }
        diffs.push.apply(diffs, dispatch("newTableEntry", {}, true));
      break;
      case "setTableEntryField":
        localState.tableEntry[info.fieldId] = info.value;
      break;

      //---------------------------------------------------------
      // Create menu
      //---------------------------------------------------------
      case "startCreating":
        localState.creating = info;
        // make sure that the tooltip isn't obstructing the creator
        var tooltip:any = {
          x: info.x,
          y: info.y,
          content: creator,
          persistent: true,
          stopPersisting: stopCreating,
        }
        dispatch("showTooltip", tooltip, true);
      break;
      case "stopCreating":
        localState.creating = false;
        dispatch("hideTooltip", {}, true);
      break;
      //---------------------------------------------------------
      // Tooltip
      //---------------------------------------------------------
      case "showButtonTooltip":
        localState.maybeShowingTooltip = true;
        var tooltip:any = {
          content: {c: "button-info", children: [
            {c: "header", text: info.header},
            {c: "description", text: info.description},
            info.disabledMessage ? {c: "disabled-message", text: "Disabled because " + info.disabledMessage} : undefined,
          ]},
          x: info.x + 5,
          y: info.y
        };
        if(!localState.tooltip) {
          localState.tooltipTimeout = setTimeout(function() {
            dispatch("showTooltip", tooltip);
          }, 500);
        } else {
          diffs = dispatch("showTooltip", tooltip, true);
        }
      break;
      case "hideButtonTooltip":
        if(localState.tooltip && localState.tooltip.persistent) return;
        clearTimeout(localState.tooltipTimeout);
        localState.maybeShowingTooltip = false;
        localState.tooltipTimeout = setTimeout(function() {
          if(!localState.maybeShowingTooltip) {
            dispatch("hideTooltip", {});
          }
        }, 10);
      break;
      case "showTooltip":
        localState.tooltip = info;
        clearTimeout(localState.tooltipTimeout);
      break;
      case "hideTooltip":
        localState.tooltip = false;
        clearTimeout(localState.tooltipTimeout);
      break;
      //---------------------------------------------------------
      // Menu
      //---------------------------------------------------------
      case "showMenu":
        localState.menu = {top: info.y, left: info.x, contentFunction: info.contentFunction};
      break;
      case "clearMenu":
        localState.menu = false;
      break;
      //---------------------------------------------------------
      // Settings
      //---------------------------------------------------------
      case "switchTab":
        localState.currentTab = info.tab;
      break;
      case "selectSave":
        localState.selectedSave = info.save;
      break;
      case "loadSave":
        var save:string = localState.selectedSave;
        if(save.substr(-4) !== ".eve") {
          save += ".eve";
        }
        if(localState.saves.indexOf(save) === -1) {
          localState.saves.push(save);
          localStorage.setItem("saves", JSON.stringify(localState.saves));
        }
        localStorage.setItem("lastSave", save);
        commands.push(["load", save]);
        diffs = dispatch("hideTooltip", {}, true);
        rerender = false;
      break;
      case "overwriteSave":
        var save:string = localState.selectedSave;
        if(save.substr(-4) !== ".eve") {
          save += ".eve";
        }
        if(localState.saves.indexOf(save) === -1) {
          localState.saves.push(save);
          localStorage.setItem("saves", JSON.stringify(localState.saves));
        }
        localStorage.setItem("lastSave", save);
        commands.push(["save", save]);
        diffs = dispatch("hideTooltip", {}, true);
      break;
      //---------------------------------------------------------
      // undo
      //---------------------------------------------------------
      case "undo":
        diffs = eveEditor.scaryUndoEvent(localState.drawnUiActiveId);
        storeEvent = false;
      break;
      case "redo":
        diffs = eveEditor.scaryRedoEvent(localState.drawnUiActiveId);
        storeEvent = false;
      break;
      default:
        console.error("Unknown dispatch:", event, info);
        break;
    }

    if(!rentrant) {
      if(diffs.length || commands.length) {
        let formatted = api.toDiffs(diffs);
        if(event === "undo" || event === "redo") {
          formatted = diffs;
        }
        if(storeEvent && formatted.length) {
          eveEditor.storeEvent(localState.drawnUiActiveId, event, formatted);
        }
        ixer.handleDiffs(formatted);
        client.sendToServer(formatted, false, commands);
        // @HACK: since we load positions up once and assume we're authorative, we have to handle
        // the case where an undo/redo can change positions without going through the normal
        // dispatch. To deal with this, we'll just reload our positions on undo and redo.
        if(event === "undo" || event === "redo") {
          loadPositions();
        }
      }
      if(rerender) {
        render();
      }
    }
    return diffs;
  }

  //---------------------------------------------------------
  // Search
  //---------------------------------------------------------

  function scoreHaystack(haystack, needle) {
    let score = 0;
    let found = {};
    let lowerHaystack = haystack.toLowerCase();
    if(needle.length === 1 && haystack === needle[0]) {
      score += 2;
    }
    for(let word of needle) {
      let ix = lowerHaystack.indexOf(word);
      if(ix === 0) {
        score += 1;
      }
      if(ix > -1) {
        score += 1;
        found[word] = ix;
      }
    }
    return {score, found};
  }

  function sortByScore(a, b) {
    let aScore = a.score.score;
    let bScore = b.score.score;
    if(aScore === bScore) {
      return b.text.length - a.text.length;
    }
    return aScore - bScore;
  }

  var availableFilters = ["field", "tag"];
  function searchResultsFor(searchValue) {
    let start = api.now();

    // search results should be an ordered set of maps that contain the kind of results
    // being provided, the ordered set of results, and a selection handler
    let searchResults = [];

    // see if there are any filters
    let filters = [];
    let normalizedSearchValue = searchValue.trim().toLowerCase();
    for(let filter of availableFilters) {
      let regex = new RegExp(`\\[${filter}:(.*?)\\]\s*`, "g");
      let origSearch = normalizedSearchValue;
      let match;
      while(match = regex.exec(origSearch)) {
        normalizedSearchValue = normalizedSearchValue.replace(match[0], "");
        filters.push({type: filter, value: match[1].trim()});
      }
    }

    let needle = normalizedSearchValue.trim().split(" ");

    let rels = searchRelations(needle, filters);
    if(rels) searchResults.push(rels);

    let glossary = searchGlossary(needle);
    if(glossary) searchResults.push(glossary);

    let end = api.now();
    if(end - start > 5) {
      console.error("Slow search (>5 ms):", end - start, searchValue);
    }
    return searchResults;
  }

  function arrayIntersect(a, b) {
    let ai = 0;
    let bi = 0;
    let result = [];
    while(ai < a.length && bi < b.length){
       if (a[ai] < b[bi] ){ ai++; }
       else if (a[ai] > b[bi] ){ bi++; }
       else {
         result.push(a[ai]);
         ai++;
         bi++;
       }
    }
    return result;
  }

  function searchRelations(needle, filters) {
    let matchingViews = [];
    let viewIds;
    //handle filters
    for(let filter of filters) {
      if(filter.type === "field") {
        // we need to only look at views with a field with the given name
        var potentialViews = [];
        ixer.select("display name", {name: filter.value}).forEach((name) => {
          let field = ixer.selectOne("field", {field: name["display name: id"]});
          if(field) {
            potentialViews.push(field["field: view"]);
          }
       });
       potentialViews.sort();
       if(!viewIds) {
          viewIds = potentialViews;
        } else {
          viewIds = arrayIntersect(viewIds, potentialViews);
        }
      } else if(filter.type === "tag") {
        // we only look at views with the given tag
        let tagged = ixer.select("tag", {tag: filter.value});
        if(!viewIds) {
          viewIds = [];
          tagged.forEach((tag) => {
            viewIds.push(tag["tag: view"]);
          });
          viewIds.sort();
        } else {
          let taggedIds = tagged.map((tag) => tag["tag: view"]).sort();
          viewIds = arrayIntersect(viewIds, taggedIds);
        }
      }
    }

    if(!filters.length) {
      viewIds = ixer.select("view", {}).map((view) => view["view: view"]);
    }

    for(let viewId of viewIds) {
      if(!localStorage["showHidden"] && ixer.selectOne("tag", {view: viewId, tag: "hidden"})) {
        continue;
      }
      let name = code.name(viewId);
      let score = scoreHaystack(name, needle);
      if(score.score) {
        let description = ixer.selectOne("view description", {view: viewId});
        if(description) {
          description = description["view description: description"];
        } else {
          description = "No description :(";
        }
        matchingViews.push({text: name, viewId, score, description});
      }
    }
    matchingViews.sort(sortByScore);
    return {kind: "Sources", results: matchingViews, onSelect: (e, elem) => {
      if(localState.drawnUiActiveId) {
        dispatch("addViewAndMaybeJoin", {viewId: elem.result.viewId});
      } else {
        dispatch("openItem", {itemId: elem.result.viewId})
      }
    }};
  }

  function searchGlossary(needle) {
    let matchingTerms = [];
    for(let term of glossary.terms) {
      let score = scoreHaystack(term.term, needle);
      if(score.score) {
        matchingTerms.push({text: term.term, description: term.description, score});
      }
    }
    matchingTerms.sort(sortByScore);
    return {kind: "Glossary", results: matchingTerms, onSelect: () => { console.log("selected glossary item")}};
  }

  //---------------------------------------------------------
  // root
  //---------------------------------------------------------

  function root() {
    var page:any;
    let viewId = localState.drawnUiActiveId;
    if(viewId) {
      let viewKind = ixer.selectOne("view", {view: viewId})["view: kind"];
      if(viewKind === "join") {
        page = queryUi(viewId, true);
      } else if(viewKind === "table") {
        page = tableUi(viewId);
      } else if(viewKind === "union") {
        console.error("TODO: implement union view");
        page = itemSelector();
      }

    } else {
      page = itemSelector();
    }
    return {id: "root", children: [tooltipUi(), page]};
  }

  function visibleItemCount() {
    let allViews = ixer.select("view", {});
    let totalCount = allViews.length;
    // hidden views don't contribute to the count
    if(!localStorage["showHidden"]) {
      totalCount -= ixer.select("tag", {tag: "hidden"}).length
    }
    // primtive views don't contribute to the count
    totalCount -= ixer.select("view", {kind: "primitive"}).length;
    return totalCount;
  }

  function itemSelector() {
    let viewIds;
    let searching = false;
    let totalCount = visibleItemCount();
    if(localState.searchingFor && localState.searchResults && localState.searchResults.length) {
      viewIds = localState.searchResults[0].results.map((searchResult) => searchResult.viewId);
      searching = true;
    } else {
      viewIds = ixer.select("view", {}).map((view) => view["view: view"]);
    }
    let queries = [];
    viewIds.forEach((viewId) : any => {
      let view = ixer.selectOne("view", {view: viewId});
      let kind = view["view: kind"];
      if(!searching && ixer.selectOne("tag", {view: viewId, tag: "hidden"})) {
        return;
      }
      if(kind === "join") {
        return queries.push(queryItem(view));
      }
      if(kind === "table") {
        return queries.push(tableItem(view["view: view"]));
      }
    });
    let actions = {
      "search": {func: startSearching, text: "Search", description: "Search for items to open by name"},
      "create": {func: startCreating, text: "Create", description: "Create a new set of data, query, or merge"},
      "remove": {func: removeSelectedItems, text: "Remove", description: "Remove an item from the database"},
    };
    let disabled = {};
    // if nothing is selected, then remove needs to be disabled
    if(!Object.keys(localState.selectedItems).length) {
      disabled["remove"] = "no items are selected to be removed. Click on one of the cards to select it.";
    }
    return {c: "query-selector-wrapper", children: [
      leftToolbar(actions, disabled),
      {c: "query-selector-body", click: clearSelectedItems, children: [
        {c: "query-selector-filter", children: [
          searching ? {c: "searching-for", children: [
            {text: `Searching for`},
            {c: "search-text", text: localState.searchingFor}
          ]} : undefined,
          queries.length === totalCount ? {c: "showing", text: `Showing all ${totalCount} items`} : {c: "showing", text: `found ${queries.length} of ${totalCount} items.`},
        ]},
        {c: "query-selector", children: queries}
      ]}
    ]};
  }

  function clearSelectedItems(e, elem) {
    dispatch("clearSelectedItems", {});
  }

  function removeSelectedItems(e, elem) {
    dispatch("removeSelectedItems", {})
  }

  function startCreating(e, elem) {
    let rect = e.currentTarget.getBoundingClientRect();
    dispatch("startCreating", {x: rect.right + 10, y: rect.top});
  }

  function stopCreating(e, elem) {
    dispatch("stopCreating", {});
  }

  function creator() {
    return {c: "creator", children: [
      {c: "header", text: "Create"},
      {c: "description", text: "Create a set of data if you want to input some values into Eve. Create a query if you want to work with your data. Create a union if you want to merge a bunch of different queries or data sets together."},
      {c: "types", children: [
        {c: "type", text: "Data", click: createNewItem, kind: "table", newName: "New table!"},
        {c: "type", text: "Query", click: createNewItem, kind: "join", newName: "New query!"},
        {c: "type", text: "Union", click: createNewItem, kind: "union", newName: "New union!"},
      ]}
    ]};
  }

  function queryItem(view) {
    let viewId = view["view: view"];
    let entityInfo = viewToEntityInfo(view);
    let boundingBox = nodesToRectangle(entityInfo.nodes);
    // translate the canvas so that the top left corner is the top left corner of the
    // bounding box for the nodes
    let xTranslate = -boundingBox.left;
    let yTranslate = -boundingBox.top;
    let scale;
    // scale the canvas so that it matches the size of the preview, preserving the aspect-ratio.
    if(boundingBox.width > previewWidth || boundingBox.height > previewHeight) {
      scale = Math.min(previewWidth / boundingBox.width, previewHeight / boundingBox.height);
    } else {
      scale = 0.7;
    }
    let selected = localState.selectedItems[viewId] ? "selected" : "";
    return {c: `query-item ${selected}`, id: viewId, itemId: viewId, click: selectItem, dblclick: openItem, children:[
      {c: "query-name", text: code.name(viewId)},
      // {c: "query-description", text: getDescription(viewId)},
      {c: "query", children: [
        {c: "container", children: [
          {c: "surface", transform:`scale(${scale}, ${scale}) translate(${xTranslate}px, ${yTranslate}px) `, children: [
            queryPreview(view, entityInfo, boundingBox)
          ]},
        ]}
      ]}
    ]};
  }

  function createNewItem(e, elem) {
    dispatch("createNewItem", {name: elem.newName, kind: elem.kind});
  }

  function selectItem(e, elem) {
    e.stopPropagation();
    dispatch("selectItem", {itemId: elem.itemId, shiftKey: e.shiftKey});
  }

  function openItem(e, elem) {
    dispatch("openItem", {itemId: elem.itemId});
  }

  function queryUi(viewId, showResults = false) {
    var view = ixer.selectOne("view", {view: viewId});
    if(!view) return;
    let entityInfo = viewToEntityInfo(view);
    let description = "No description :(";
    let viewDescription = ixer.selectOne("view description", {view: viewId});
    if(viewDescription) {
      description = viewDescription["view description: description"];
    }
    return {c: "query query-editor", children: [
      localState.drawnUiActiveId ? queryTools(view, entityInfo) : undefined,
      {c: "container", children: [
        {c: "surface", children: [
          queryMenu(view),
          {c: "query-workspace", children: [
            {c: "query-name-input", contentEditable: true, blur: rename, renameId: viewId, text: code.name(viewId)},
            {c: "query-description-input", contentEditable: true, blur: setQueryDescription, viewId, text: description},
            queryCanvas(view, entityInfo),
          ]},
          queryErrors(view),
        ]},
        showResults ? queryResults(viewId, entityInfo) : undefined
      ]}
    ]};
  }

  function tooltipUi(): any {
    let tooltip = localState.tooltip;

    if(tooltip) {
      let viewHeight = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
       // @FIXME: We need to get the actual element size here.
      let elem:any = {c: "tooltip" + (tooltip.c ? " " + tooltip.c : ""), left: tooltip.x, top: Math.min(tooltip.y, viewHeight - 61)};
      if(typeof tooltip.content === "string") {
        elem["text"] = tooltip.content;
      } else if(typeof tooltip.content === "function") {
        elem["children"] = [tooltip.content()];
      } else {
        elem["children"] = [tooltip.content];
      }
      if(tooltip.persistent) {
        return {id: "tooltip-container", c: "tooltip-container", children: [
          {c: "tooltip-shade", click: tooltip.stopPersisting},
          elem,
        ]};
      }
      return elem;
    }
  }

  function queryErrors(view) {
    let errors = localState.errors.map((error) => {
      let klass = "error";
      if(error.fading) {
        klass += " fade";
      }
      return {c: klass, text: error.text};
    }).reverse();
    return {c: "query-errors", children: errors};
  }

  function queryTools(view, entityInfo) {
    let viewId = view["view: view"];
    let {nodeLookup} = entityInfo;

    let selectedNodes = Object.keys(localState.selectedNodes).map(function(nodeId) {
      // we can't rely on the actual nodes of the uiSelection because they don't get updated
      // so we have to look them up again.
      return nodeLookup[nodeId];
    }).filter((node) => node);

    let disabled = {};
    let actions = {
      // What tools are available depends on what is selected.
      // no matter what though you should be able to go back to the
      // query selector and search.
      "Back": {func: gotoItemSelector, text: "Back", description: "Return to the item selection page"},
      "Search": {func: startSearching, text: "Search", description: "Find sources to add to your query"},
      // These may get changed below depending on what's selected and the
      // current state.
      "join": {func: joinSelection, text: "Join"},
      "select": {func: selectAttribute, text: "Show"},
      "filter": {func: addFilter, text: "Filter"},
      "group": {func: groupAttribute, text: "Group"},
      "sort": {func: startSort, text: "Sort"},
      "chunk": {func: chunkSource, text: "Chunk"},
      "ordinal": {func: addOrdinal, text: "Ordinal"},
      "negate": {func: negateSource, text: "Negate"},
    }

    // no selection
    if(!selectedNodes.length) {
      disabled = {
        "join": "join only applies to attributes",
        "select": "select only applies to attributes",
        "filter": "filter only applies to attributes",
        "group": "group only applies to attributes",
        "sort": "sort only applies to sources",
        "chunk": "chunk only applies to sources",
        "ordinal": "ordinal only applies to sources",
        "negate": "negate only applies to sources",
      }

    // single selection
    } else if(selectedNodes.length === 1) {
      let node = selectedNodes[0];
      if(node.type === "attribute") {
        disabled["sort"] = "sort only applies to sources";
        disabled["chunk"] = "chunk only applies to sources";
        disabled["ordinal"] = "ordinal only applies to sources";
        disabled["negate"] = "negate only applies to sources";
        if(!node.mergedAttributes) {
          // you can't select a node if the source is negated and it's not joined with anything else
          if(node.sourceNegated) {
            disabled["select"] = "negated sources prove the absence of a row, which means you'd be selecting from nothing."
          }
          disabled["join"] = "multiple attributes aren't joined together on this node.";
        } else {
          actions["join"] = {func: unjoinNodes, text: "Unjoin"};
        }

        if(ixer.selectOne("select", {variable: node.variable})) {
          actions["select"] = {func: unselectAttribute, text: "Hide"};
        }
        if(node.filter) {
          actions["filter"] = {func: removeFilter, text: "Unfilter"};
        }
        // if this node's source is chunked or there's an ordinal binding, we can group
        if(node.sourceChunked || node.sourceHasOrdinal) {
          if(node.grouped) {
            actions["group"] = {func: ungroupAttribute, text: "Ungroup"};
          }
        } else {
          disabled["group"] = "To group an attribute, the source must either have an ordinal or be chunked";
        }
      } else if(node.type === "relationship") {
        disabled["select"] = "select only applies to attributes.";
        disabled["filter"] = "filter only applies to attributes.";
        disabled["group"] = "group only applies to attributes.";
        disabled["join"] = "join only applies to attributes.";
        if(node.chunked) {
          actions["chunk"] = {func: unchunkSource, text: "Unchunk"};
        }
        if(node.isNegated) {
          actions["negate"] = {func: unnegateSource, text: "Unnegate"};
        }
        if(node.hasOrdinal) {
          actions["ordinal"] = {func: removeOrdinal, text: "Unordinal"};
        }

      }

    //multi-selection
    } else {
      disabled = {
        "filter": "filter only applies to single attributes",
        "group": "group only applies to single attributes",
        "sort": "sort only applies to single sources",
        "chunk": "chunk only applies to single sources",
        "ordinal": "ordinal only applies to single sources",
        "negate": "negate only applies to single sources",
      }

      // join and select are only valid if everything is an attribute, so if we
      // find a non-attribute, we have to disable them
      if(selectedNodes.some((node) => node.type !== "attribute")) {
        disabled["join"] = "join only applies to attributes";
        disabled["select"] = "select only applies to attributes";
      } else {
        // whether or not we are showing or hiding is based on the state of the first node
        // in the selection
        let root = selectedNodes[0];
        if(ixer.selectOne("select", {variable: root.variable})) {
          actions["select"] = {func: unselectSelection, text: "Hide"};
        } else {
          actions["select"] = {func: selectSelection, text: "Show"};
        }
      }
    }
    return leftToolbar(actions, disabled, {node: selectedNodes[0], viewId});
  }

  function leftToolbar(actions, disabled = {}, extraKeys = {}) {
    var tools = [];
    for(let actionName in actions) {
      let action = actions[actionName];
      let description = action.description;
      if(glossary.lookup[action.text]) {
        description = glossary.lookup[action.text].description;
      }
      let tool = {c: "tool", text: action.text, mouseover: showButtonTooltip, mouseout: hideButtonTooltip, description};
      for(var extraKey in extraKeys) {
        tool[extraKey] = extraKeys[extraKey];
      }
      if(!disabled[actionName]) {
        tool["click"] = action.func;
      } else {
        tool["c"] += " disabled";
        tool["disabledMessage"] = disabled[actionName];
      }
      tools.push(tool);
    }
    tools.push({c: "flex-spacer"},
               {c: "tool ion-gear-b",
                title: "Settings",
                mouseover: showButtonTooltip,
                mouseout: hideButtonTooltip,
                click: openSettings,
                description: "Open Eve's settings panel"})

    return {c: "left-side-container", children: [
      {c: "query-tools", children: tools},
      querySearcher()
    ]};
  }

  function openSettings(evt, elem:Element) {
    let rect = evt.currentTarget.getBoundingClientRect();
    let tooltip:any = {
      c: "settings-modal",
      content: settingsPanel,
      persistent: true,
      stopPersisting: stopSort,
    };
    dispatch("showTooltip", tooltip);
  }

  let settingsPanes = {
    "save": {
      title: "Save",
      content: function() {
        let saves = localState.saves || [];
        let selected = localState.selectedSave;
        return [
          (saves.length ? {children: [
            {t: "h3", text: "Recent"},
            {c: "saves", children: saves.map((save) => { return {
              c: (save === selected) ? "selected" : "",
              text: save,
              save: save,
              click: selectSave,
              dblclick: overwriteSave
            }})}
          ]} : undefined),
          
          {c: "flex-row spaced-row", children: [{t: "input", input: setSaveLocation}, {t: "button", text: "Save", click: overwriteSave}]}
        ];
      }
    },
    "load": {
      title: "Load",
      content: function() {
        let saves = localState.saves || [];
        let selected = localState.selectedSave;
        return [
          (saves.length ? {children: [
            {t: "h3", text: "Recent"},
            {c: "saves", children: saves.map((save) => { return {
              c: (save === selected) ? "selected" : "",
              text: save,
              save: save,
              click: selectSave,
              dblclick: loadSave
            }})}
          ]} : undefined),
          {c: "flex-row spaced-row", children: [{t: "input", input: setSaveLocation}, {t: "button", text: "Load", click: loadSave}]}
        ]
      }
    },
    "preferences": {
      title: "Preferences",
      content: () =>  [{text: "💩"}]
    }
  };
  
  function settingsPanel() {
    let current = settingsPanes[localState.currentTab] ? localState.currentTab : "preferences";
    let tabs = [];
    for(let tab in settingsPanes) {
      tabs.push({c: (tab === current) ? "active tab" : "tab", tab, text: settingsPanes[tab].title, click: switchTab});
    }
    
    return {c: "settings-panel tabbed-box", children: [
      {c: "tabs", children: tabs},
      {c: "pane", children: settingsPanes[current].content()}
    ]};
  }
  
  function switchTab(evt, elem) {
    dispatch("switchTab", {tab: elem.tab});
  }
  
  function selectSave(evt, elem) {
    dispatch("selectSave", {save: elem.save});
  }
  
  function setSaveLocation(evt, elem) {
    dispatch("selectSave", {save: evt.currentTarget.value});
  }
  
  function overwriteSave(evt, elem) {
    dispatch("overwriteSave", {});
  }
  
  function loadSave(evt, elem) {
    dispatch("loadSave", {});
  }

  function sorter() {
    let sourceId = localState.sorting.sourceId;
    let sourceViewId = ixer.selectOne("source", {source: sourceId})["source: source view"];
    let fieldItems = ixer.getFields(sourceViewId).map((field, ix) => {
      let sortedField = ixer.selectOne("sorted field", {source: sourceId, field: field});
      let sortIx = sortedField ? sortedField["sorted field: ix"] : ix;
      let sortArrow = sortedField["sorted field: direction"] === "ascending" ? "ion-arrow-up-b" : "ion-arrow-down-b";
      return {c: "field", draggable: true, dragstart: sortDragStart, dragover: sortFieldDragOver, drop: sortFieldDrop, sortIx, sourceId, children: [
        {c: "field-name", text: code.name(field)},
        {c: `sort-direction ${sortArrow}`, sortedField, click: toggleSortDirection},
      ]};
    });
    fieldItems.sort((a, b) => {
      return a.sortIx - b.sortIx;
    });
    return {c: "sorter", children: [
        {c: "header", text: "Adjust sorting"},
        {c: "description", text: "Order the fields in the order you want them to be sorted in and click the arrow to adjust whether to sort ascending or descending"},
        {c: "fields", children: fieldItems}
      ]};
  }

  function querySearcher() {
    if(!localState.searching) return;
    let results = localState.searchResults;
    let resultGroups = [];
    if(results) {
      resultGroups = results.map((resultGroup) => {
        let onSelect = resultGroup.onSelect;
        let items = resultGroup.results.map((result) => {
          return {c: "search-result-item", result, click: onSelect, children: [
            {c: "result-text", text: result.text},
            result.description ? {c: "result-description", text: result.description} : undefined,
          ]};
        });
        return {c: "search-result-group", children: [
          // @HACK: setting value here is weird, but it causes the postRender to get called every time the search changes
          // which will ensure that the results are always scrolled to the bottom
          {c: "search-result-items", value: localState.searchingFor, postRender: scrollToTheBottomOnChange, children: items},
          {c: "group-type", children: [
            {c: "group-name", text: resultGroup.kind},
            {c: "result-size", text: resultGroup.results.length}
          ]},
        ]}
      });
    }
    return {c: "searcher-container", children: [
      {c: "searcher-shade", click: stopSearching},
      {c: "searcher", children: [
        {c: "search-results", children: resultGroups},
        {c: "search-box", contentEditable: true, postRender: focusOnce, text: localState.searchingFor, input: updateSearch, keydown: handleSearchKey}
      ]}
    ]};
  }

  function toggleSortDirection(e, elem) {
    dispatch("toggleSortDirection", {sourceId: elem.sortedField["sorted field: source"], fieldId: elem.sortedField["sorted field: field"]});
  }

  function sortDragStart(e, elem) {
    e.dataTransfer.setData("sortIx", elem.sortIx);
  }

  function sortFieldDragOver(e, elem) {
    e.preventDefault();
  }

  function sortFieldDrop(e, elem) {
    e.preventDefault();
    dispatch("moveSortField", {
      sourceId: elem.sourceId,
      from: parseInt(e.dataTransfer.getData("sortIx")),
      to: elem.sortIx,
    });
  }

  function scrollToTheBottomOnChange(node, elem) {
    if(!node.searchValue || node.searchValue !== elem.value) {
      node.scrollTop = Number.MAX_VALUE;
      node.searchValue = elem.value;
    }
  }

  function stopSort(e, elem) {
    dispatch("stopSort", {});
  }

  function startSort(e, elem) {
    let rect = e.currentTarget.getBoundingClientRect();
    dispatch("startSort", {x: rect.right + 10, y: rect.top, sourceId: elem.node.id});
  }

  function showButtonTooltip(e, elem) {
    let rect = e.currentTarget.getBoundingClientRect();
    dispatch("showButtonTooltip", {header: elem.text || elem.title, disabledMessage: elem.disabledMessage, description: elem.description, x: rect.right, y: rect.top} );
  }

  function hideButtonTooltip(e, elem) {
    dispatch("hideButtonTooltip", {});
  }

  function handleSearchKey(e, elem) {
    dispatch("handleSearchKey", {keyCode: e.keyCode, metaKey: e.metaKey, ctrlKey: e.ctrlKey, e});
  }

  function startSearching(e, elem) {
    dispatch("startSearching", {value: elem.searchValue});
  }

  function stopSearching(e, elem) {
    dispatch("stopSearching", {});
  }

  function updateSearch(e, elem) {
    dispatch("updateSearch", {value: e.currentTarget.textContent});
  }

  function joinSelection(e, elem) {
    dispatch("joinSelection", {});
  }

  function selectSelection(e, elem) {
    dispatch("selectSelection", {});
  }

  function unselectSelection(e, elem) {
    dispatch("unselectSelection", {});
  }

  function groupAttribute(e, elem) {
    dispatch("groupAttribute", {node: elem.node, viewId: elem.viewId});
  }

  function ungroupAttribute(e,elem) {
    dispatch("ungroupAttribute", {node: elem.node, viewId: elem.viewId});
  }

  function negateSource(e, elem) {
    dispatch("negateSource", {sourceId: elem.node.id, viewId: elem.viewId});
  }

  function unnegateSource(e, elem) {
    dispatch("unnegateSource", {sourceId: elem.node.id, viewId: elem.viewId});
  }

  function addOrdinal(e, elem) {
    dispatch("addOrdinal", {node: elem.node, viewId: elem.viewId});
  }

  function removeOrdinal(e, elem) {
    dispatch("removeOrdinal", {node: elem.node, viewId: elem.viewId});
  }


  function chunkSource(e, elem) {
    dispatch("chunkSource", {node: elem.node, viewId: elem.viewId});
  }

  function unchunkSource(e, elem) {
    dispatch("unchunkSource", {node: elem.node, viewId: elem.viewId});
  }

  function addFilter(e, elem) {
    dispatch("addFilter", {node: elem.node, viewId: elem.viewId});
  }

  function removeFilter(e, elem) {
    dispatch("removeFilter", {node: elem.node, viewId: elem.viewId});
  }

  function modifyFilter(e, elem) {
    dispatch("modifyFilter", {node: elem.node});
  }

  function unselectAttribute(e, elem) {
    dispatch("removeSelectFromQuery", {viewId: elem.viewId, variableId: elem.node.variable});
  }
  function selectAttribute(e, elem) {
    dispatch("addSelectToQuery", {viewId: elem.viewId, variableId: elem.node.variable, name: elem.node.name});
  }

  function queryResults(viewId, entityInfo) {
    let resultViewId = viewId;
    let selectedNodeIds = Object.keys(localState.selectedNodes);
    let peek;
    if(selectedNodeIds.length === 1 && localState.selectedNodes[selectedNodeIds[0]].type === "relationship") {
      let peekViewId = localState.selectedNodes[selectedNodeIds[0]].source["source: source view"];
      let numFields = ixer.select("field", {view: peekViewId}).length;
      let rect = nodesToRectangle(entityInfo.nodes);
      let peekViewSize = ixer.select(peekViewId, {}).length;
      peek = {c: "peek-results", width: numFields * 100, left: rect.right + 50, top: (rect.top + rect.height /2) - 75, children: [
        {c: "result-size", text: `${peekViewSize} rows`},
        tableEditor.tableForView(peekViewId, 100),

      ]};
    }
    let resultViewSize = ixer.select(resultViewId, {}).length;
    return {c: "query-results", children: [
      peek,
      {c: "query-results-container", children: [
        {c: "result-size", text: `${resultViewSize} results`},
        tableEditor.tableForView(resultViewId, 100)
      ]}
    ]};
  }

  export function rename(e, elem) {
    dispatch("rename", {renameId: elem.renameId, value: e.currentTarget.textContent});
  }

  function setQueryDescription(e, elem) {
    dispatch("setQueryDescription", {viewId: elem.viewId, value: e.currentTarget.textContent});
  }

  function gotoItemSelector(e, elem) {
    dispatch("gotoItemSelector", {});
  }

  function queryMenu(query) {
    var menu = localState.menu;
    if(!menu) return {};
    return {c: "menu-shade", mousedown: clearMenuOnClick, children: [
      {c: "menu", top: menu.top, left: menu.left, children: [
        menu.contentFunction()
      ]}
    ]};
  }

  function clearMenuOnClick(e, elem) {
    if(e.target === e.currentTarget) {
      dispatch("clearMenu", {});
    }
  }


  function joinToEntityInfo(view) {
    var nodes = [];
    var nodeLookup = {};
    var constraints = [];
    var links = [];
    let viewId = view["view: view"];
    for(var source of ixer.select("source", {view: viewId})) {
      var sourceViewId = source["source: source view"];
      var sourceView = api.ixer.selectOne("view", {view: sourceViewId});
      if(!sourceView) {
        console.error("Source view not found for source:", source);
        continue;
      }
      var sourceId = source["source: source"];
      if(sourceView["view: kind"] !== "primitive") {
        var isRel = true;
        var curRel:any = {type: "relationship", source: source, id: sourceId, name: code.name(sourceViewId)};
        nodes.push(curRel);
        nodeLookup[curRel.id] = curRel;
        if(ixer.selectOne("chunked source", {source: sourceId})) {
          curRel.chunked = true;
        }
        if(ixer.selectOne("ordinal binding", {source: sourceId})) {
          curRel.hasOrdinal = true;
        }
        if(ixer.selectOne("negated source", {source: sourceId})) {
          curRel.isNegated = true;
        }
      } else {
        var curPrim: any = {type: "primitive", sourceId: sourceId, primitive: sourceViewId, name: code.name(sourceViewId)};
        curPrim.id = curPrim.sourceId;
        nodes.push(curPrim);
        nodeLookup[curPrim.id] = curPrim;
      }
    }

    //look through the variables and dedupe attributes
    let variables = ixer.select("variable", {view: view["view: view"]});
    for(let variable of variables) {
      let variableId = variable["variable: variable"];
      let bindings = ixer.select("binding", {variable: variableId});
      let constants = ixer.select("constant binding", {variable: variableId});
      let ordinals = ixer.select("ordinal binding", {variable: variableId});
      let attribute:any = {type: "attribute", id: variableId, variable: variableId};

       // if we have bindings, this is a normal attribute and we go through to create
       // links to the sources and so on.
      if(bindings.length) {
        let entity = undefined;
        let name = "";
        let singleBinding = bindings.length === 1;

        // check if an ordinal is bound here.
        if(ordinals.length) {
          let sourceNode = nodeLookup[ordinals[0]["ordinal binding: source"]];
          if(sourceNode) {
            let link: any = {left: attribute, right: sourceNode, name: "ordinal"};
            links.push(link);
          }
          name = "ordinal";
        }

        // run through the bindings once to determine if it's an entity, what it's name is,
        // and all the other properties of this node.
        for(let binding of bindings) {
          let sourceId = binding["binding: source"];
          let fieldId = binding["binding: field"];
          let fieldKind = ixer.selectOne("field", {field: fieldId})["field: kind"];
          if(!entity) entity = fieldToEntity[fieldId];
          // we don't really want to use input field names as they aren't descriptive.
          // so we set the name only if this is an output or there isn't a name yet
          if(fieldKind === "output" || !name) {
            name = code.name(fieldId);
          }
          // if it's a single binding and it's an input then this node is an input
          if(singleBinding && fieldKind !== "output") {
            attribute.isInput = true;
            attribute.inputKind = fieldKind;
          }
          let grouped = ixer.selectOne("grouped field", {source: sourceId, field: fieldId});
          if(grouped) {
            attribute.grouped = true;
          }
          let sourceNode = nodeLookup[sourceId];
          if(sourceNode) {
            attribute.sourceChunked = attribute.sourceChunked || sourceNode.chunked;
            attribute.sourceHasOrdinal = attribute.sourceHasOrdinal || sourceNode.hasOrdinal;
            attribute.sourceNegated = attribute.sourceNegated || sourceNode.isNegated;
          }
        }


        // the final name of the node is either the entity name or the whichever name we picked
        name = entity || name;
        // now that it's been named, go through the bindings again and create links to their sources
        for(let binding of bindings) {
          let sourceId = binding["binding: source"];
          let fieldId = binding["binding: field"];
          let sourceNode = nodeLookup[sourceId];
          // @FIXME: because the client isn't authorative about code, there are cases where the source
          // is removed but the variable still exists. Once the AST is editor-owned, this will no longer
          // be necessary.
          if(!sourceNode) continue;
          let link: any = {left: attribute, right: sourceNode};
          let fieldName = code.name(fieldId);
          if(fieldName !== name) {
            link.name = fieldName;
          }
          links.push(link);
        }
        attribute.name = name;
        attribute.mergedAttributes = bindings.length + ordinals.length > 1 ? bindings : undefined;
        attribute.entity = entity;
        attribute.select = ixer.selectOne("select", {variable: variableId});
        for(var constant of constants) {
          attribute.filter = {operation: "=", value: constant["constant binding: value"]};
        }
      } else if(constants.length) {
        // some variables are just a constant
        attribute.name = "constant binding";
        attribute.filter = {operation: "=", value: constants[0]["constant binding: value"]};
      } else if(ordinals.length) {
        // we have to handle ordinals specially since they're a virtual field on a table
        attribute.isOrdinal = true;
        attribute.name = "ordinal";
        attribute.select = ixer.selectOne("select", {variable: variableId});
        let sourceNode = nodeLookup[ordinals[0]["ordinal binding: source"]];
        if(sourceNode) {
          let link: any = {left: attribute, right: sourceNode, name: "ordinal"};
          links.push(link);
        }
      } else {
        attribute.name = "unknown variable";
      }
      nodeLookup[attribute.id] = attribute;
      nodes.push(attribute);
    }

    return {nodes, links, nodeLookup};
  }

  function tableToEntityInfo(view) {
    var nodes = [];
    var links = [];
    let nodeLookup = {};
    return {nodes, links, nodeLookup};
  }

  function viewToEntityInfo(view) {
    if(view["view: kind"] === "join") {
      return joinToEntityInfo(view);
    } else if(view["view: kind"] === "table") {
      return tableToEntityInfo(view);
    } else {
      let nodes = [];
      let links = [];
      let nodeLookup = {};
      return {nodeLookup, nodes, links}
    }
  }

  function drawLinks(links, items) {
    var linkItems = [];
    for(var link of links) {
      var leftItem, rightItem;
      for(var item of items) {
        if(item.node === link.left) {
          leftItem = item;
          break;
        }
      }
      for(var item of items) {
        if(item.node === link.right) {
          rightItem = item;
          break;
        }
      }

      if(leftItem.left <= rightItem.left) {
      var fromLeft = leftItem.left + (leftItem.size.width / 2);
        var fromTop = leftItem.top + (leftItem.size.height / 2);
        var toLeft = rightItem.left + (rightItem.size.width / 2);
        var toTop = rightItem.top + (rightItem.size.height / 2);
      } else {
        var fromLeft = rightItem.left + (rightItem.size.width / 2);
        var fromTop = rightItem.top + (rightItem.size.height / 2);
        var toLeft = leftItem.left + (leftItem.size.width / 2);
        var toTop = leftItem.top + (leftItem.size.height / 2);
      }
      var color = "#bbb";
      var d = `M ${fromLeft} ${fromTop} L ${toLeft} ${toTop}`;

      var pathId = `${link.right.id} ${link.left.id} path`;
      linkItems.push({svg: true, id: pathId, t: "path", d: d, c: "link", stroke: color, strokeWidth: 1});
      linkItems.push({svg: true, t: "text", children: [
        {svg: true, t: "textPath", startOffset: "50%", xlinkhref: `#${pathId}`, text: link.name}
      ]});
    }
    return linkItems;
  }

  function refreshNodePositions(nodes, links) {
    let sourceNodes:graphLayout.Node[] = [];
    let attributeNodes:graphLayout.Node[] = [];
    let dirty = false;
    for(let node of nodes) {
      let displayInfo = nodeDisplayInfo(node);
      let width = displayInfo.totalWidth + 10;
      let height = displayInfo.totalHeight + 10;
      let graphNode:graphLayout.Node = {id: node.id, type: node.type, width, height };
      if(displayInfo.left !== undefined && displayInfo.top !== undefined) {
        graphNode.x = displayInfo.left + width / 2;
        graphNode.y = displayInfo.top + height / 2;
      } else {
        dirty = true;
      }
      if(node.type === "relationship" || node.type === "primitive") {
        sourceNodes.push(graphNode);
      } else if(node.type === "attribute") {
        attributeNodes.push(graphNode);
      } else {
        console.warn("unhandled node type:", node.type);
      }
    }


    if(dirty) {
      let edges:graphLayout.Edge[] = [];
      for(let link of links) { // Right is source, left is attribute.
        edges.push({source: link.right.id, target: link.left.id});
      }

      let graph = new graphLayout.Graph(sourceNodes, attributeNodes, edges);
      let layout = graph.layout();
      for(let node of nodes) {
        let p = layout.positions[node.id];
        let s = layout.sizes[node.id];
        let neue = {left: p[0] - s[0] / 2 - 5, top: p[1] - s[1] / 2 - 5};
        let old = positions[node.id];
        if(!old || old.left !== neue.left || old.top !== neue.top) {
          positions[node.id] = neue;
          dispatch("initializeNodePosition", {node: node});
        }
      }
    }
  }

  function queryPreview(view, entityInfo, boundingBox) {
    let viewId = view["view: view"];
    let {nodes, links} = entityInfo;
    refreshNodePositions(nodes, links);
    var items = [];
    for(var node of nodes) {
      items.push(nodeItem(node, viewId));
    }
    let linkItems = drawLinks(links, items);
    return {c: "canvas", children: [
      {c: "links", svg: true, width: boundingBox.right, height: boundingBox.bottom, t: "svg", children: linkItems},
      {c: "nodes", children: items}
    ]};
  }

  function queryCanvas(view, entityInfo) {
    let viewId = view["view: view"];
    let {nodes, links, nodeLookup} = entityInfo;
    refreshNodePositions(nodes, links);

    var items = [];
    for(var node of nodes) {
      items.push(nodeItem(node, viewId));
    }
    let linkItems = drawLinks(links, items);
    let selection;
    if(localState.selecting) {
      let {start, end} = localState.boxSelection;
      if(end) {
        let topLeft = {x: start.x, y: start.y};
        let width = Math.abs(end.x - start.x);
        let height = Math.abs(end.y - start.y);
        if(end.x < start.x) {
          topLeft.x = end.x;
        }
        if(end.y < start.y) {
          topLeft.y = end.y;
        }
        selection = {svg: true, c: "selection-rectangle", t: "rect", x: topLeft.x, y: topLeft.y, width, height};
      }
    } else {
      let selectedNodeIds = Object.keys(localState.selectedNodes);
      if(selectedNodeIds.length) {
        let {top, left, width, height} = nodesToRectangle(selectedNodeIds.map((nodeId) => nodeLookup[nodeId]).filter((node) => node));
        selection = {svg: true, c: "selection-rectangle", t: "rect", x: left - 10, y: top - 10, width: width + 20, height: height + 20};
      }
    }
    return {c: "canvas", mousedown: startBoxSelection, mousemove: continueBoxSelection, mouseup: endBoxSelection, dragover: preventDefault, children: [
      {c: "selection", svg: true, width: "100%", height: "100%", t: "svg", children: [selection]},
      {c: "links", svg: true, width:"100%", height:"100%", t: "svg", children: linkItems},
      {c: "nodes", children: items}
    ]};
  }

  function surfaceRelativeCoords(e) {
    let surface:any = document.getElementsByClassName("query-workspace")[0];
    let surfaceRect = surface.getBoundingClientRect();
    let x = e.clientX - surfaceRect.left;
    let y = e.clientY - surfaceRect.top;
    return {x, y};
  }

  function startBoxSelection(e, elem) {
    let coords = surfaceRelativeCoords(e);
    dispatch("startBoxSelection", {coords, shiftKey: e.shiftKey});
  }
  function continueBoxSelection(e, elem) {
    if(!localState.selecting || (e.clientX === 0 && e.clientY === 0)) return;
    dispatch("continueBoxSelection", surfaceRelativeCoords(e));
  }
  function endBoxSelection(e, elem) {
    dispatch("endBoxSelection", {});
  }

  function clearCanvasSelection(e, elem) {
    if(e.target === e.currentTarget && !e.shiftKey) {
      dispatch("clearSelection", {});
    }
  }

  function nodeDisplayInfo(curNode) {
    let text = curNode.name.toString();
    let small = false;
    let {left, top} = positions[curNode.id] || {};
    let height = nodeHeight + 2 * nodeHeightPadding;
    let width = Math.max(text.length * nodeWidthMultiplier + 2 * nodeWidthPadding, nodeWidthMin);
    let right = left + width;
    let bottom = top + height;
    let filterWidth;
    if(curNode.filter) {
      filterWidth = Math.max(curNode.filter.value.toString().length * nodeWidthMultiplier + 25, nodeWidthMin);
      // subtract the 15 pixel overlap that occurs between nodes and their filters
      right += filterWidth - 15;
    }
    if(small) {
      width = Math.max(text.length * nodeSmallWidthMultiplier + nodeWidthPadding, nodeWidthMin);
    }
    return {left, top, right, bottom, width, height, text, filterWidth, totalWidth: (curNode.filter ? width + filterWidth - 15 : width), totalHeight: height};
  }

  function nodeItem(curNode, viewId): any {
    var content = [];
    var uiSelected = localState.selectedNodes[curNode.id];
    var overlapped = localState.overlappingNodes[curNode.id];
    var klass = "";
    if(uiSelected) {
      klass += " uiSelected";
    }
    if(curNode.select) {
      klass += " projected";
    }
    if(overlapped) {
      klass += " overlapped";
    }
    if(curNode.chunked) {
      klass += " chunked";
    }
    if(curNode.isNegated) {
      klass += " negated";
    }
    if((curNode.sourceChunked && !curNode.grouped) || curNode.inputKind === "vector input") {
      klass += " column";
    }
    klass += ` ${curNode.type}`;
    if (curNode.entity !== undefined) {
      klass += " entity";
    }
    var {left, top, width, height, text, filterWidth} = nodeDisplayInfo(curNode);
    if (curNode.filter && curNode.inputKind !== "vector input") {
      var op = curNode.filter.operation;
      let filterIsBeingEdited = localState.modifyingFilterNodeId === curNode.id;
      var filterUi:any = {c: "attribute-filter", dblclick: modifyFilter, node: curNode, children: [
        //{c: "operation", text: curNode.filter.operation}
      ]};

      if(filterIsBeingEdited) {
        filterUi.children.push({c: "value", children: [
          {c: "filter-editor", contentEditable: true, postRender: focusOnce, keydown: submitOnEnter,
            blur: stopModifyingFilter, viewId, node: curNode, text: curNode.filter.value}
        ]});
      } else {
        // we only want an explicit width if the filter isn't changing size to try and fit being edited.
        filterUi.width = filterWidth;
        filterUi.children.push({c: "value", text: curNode.filter.value});
      }
      content.push(filterUi);
    }
    var elem = {c: "item " + klass, selected: uiSelected, width, height,
                mousedown: selectNode, dblclick: openNode, draggable: true, dragstart: storeDragOffset,
                drag: setNodePosition, dragend: finalNodePosition, node: curNode, text};
    content.unshift(elem);
    return {c: "item-wrapper", top: top, left: left, size: {width, height}, node: curNode, selected: uiSelected, children: content};
  }

  function submitOnEnter(e, elem) {
    if(e.keyCode === api.KEYS.ENTER) {
      stopModifyingFilter(e, elem);
      e.preventDefault();
    }
  }

  function stopModifyingFilter(e, elem) {
    dispatch("stopModifyingFilter", {node: elem.node, value: coerceInput(e.currentTarget.textContent), viewId: elem.viewId});
  }

  function unjoinNodes(e, elem) {
    dispatch("unjoinNodes", {variableId: elem.node.variable});
  }

  function selectNode(e, elem) {
    e.stopPropagation();
    dispatch("selectNode", {node: elem.node, shiftKey: e.shiftKey});
  }

  function openNode(e, elem) {
    if(elem.node.type === "relationship") {
      dispatch("openRelationship", {node: elem.node});
    }
  }

  function storeDragOffset(e, elem) {
    var rect = e.currentTarget.getBoundingClientRect();
    e.dataTransfer.setDragImage(document.getElementById("clear-pixel"),0,0);
    dispatch("setDragOffset", {x: e.clientX - rect.left, y: e.clientY - rect.top});
  }

  function finalNodePosition(e, elem) {
    dispatch("finalNodePosition", {node: elem.node});
  }

  function setNodePosition(e, elem) {
    if(e.clientX === 0 && e.clientY === 0) return;
    let surface:any = document.getElementsByClassName("query-workspace")[0];
    let surfaceRect = surface.getBoundingClientRect();
    let x = e.clientX - surfaceRect.left - api.localState.dragOffsetX;
    let y = e.clientY - surfaceRect.top - api.localState.dragOffsetY;
    dispatch("setNodePosition", {
      node: elem.node,
      pos: {left: x, top: y}
    });
  }

  //---------------------------------------------------------
  // table selector / editor
  //---------------------------------------------------------

   function tableItem(tableId) {
     let selected = localState.selectedItems[tableId] ? "selected" : "";
    return {c: `table-item ${selected}`, itemId: tableId, click: selectItem, dblclick: openItem, children: [
      tableForm(tableId)
    ]};
  }

  function tableFormEditor(tableId, row = null, rowNum = 0, rowTotal = 0) {
    let fields = ixer.getFields(tableId).map((fieldId) => {
      let value = row ? row[fieldId] : "";
      let entryField = {c: "entry-field", fieldId, postRender: maybeFocusFormField, text: value, contentEditable: true, keydown: keyboardSubmitTableEntry, input: setTableEntryField, blur: clearActiveTableEntryField, focus: activeTableEntryField};
      return {c: "field-item", children: [
        {c: "label", tabindex:-1, contentEditable: true, blur: rename, renameId: fieldId, text: code.name(fieldId)},
        entryField,
      ]};
    });
    let sizeUi = rowTotal > 0 ? {c: "size", text: `${rowNum} of ${rowTotal}`} : undefined;
    return {c: "form-container", children: [
      {c: "form", children: [
        {c: "form-name", contentEditable: true, blur: rename, renameId: tableId, text: code.name(tableId)},
        {c: "form-description", contentEditable: true, blur: setQueryDescription, viewId: tableId, text: getDescription(tableId)},
        {c: "form-fields", children: fields},
        sizeUi,
        {c: "submit-button", click: submitTableEntry, text: "submit"}
      ]},
      rowTotal > 1 ? formRepeat(1) : undefined,
      rowTotal > 2 ? formRepeat(2) : undefined,
    ]};
  }

  function tableForm(tableId, editable = false) {
    let rows = ixer.select(tableId, {});
    let fields = ixer.getFields(tableId).map((fieldId) => {
      let value = rows[0] ? rows[0][fieldId] : "";
      let entryField = {c: "entry-field", text: value};
      if(editable) {
        entryField["contentEditable"] = true;
      }
      return {c: "field-item", children: [
        {c: "label", contentEditable: editable, blur: rename, renameId: fieldId, text: code.name(fieldId)},
        entryField,
      ]};
    });
    let sizeUi;
    if(!editable) {
      sizeUi = rows.length > 0 ? {c: "size", text: `1 of ${rows.length}`} : {c: "size", text: "No entries"};
    }
    return {c: "form-container", children: [
      {c: "form", children: [
        {c: "form-name", contentEditable: editable, blur: rename, renameId: tableId, text: code.name(tableId)},
        {c: "form-description", contentEditable: editable, blur: setQueryDescription, viewId: tableId, text: getDescription(tableId)},
        {c: "form-fields", children: fields},
        sizeUi,
      ]},
      rows.length > 1 ? formRepeat(1) : undefined,
      rows.length > 2 ? formRepeat(2) : undefined,
    ]};
  }

  function formRepeat(depth) {
    let offset = 4 * depth;
    let topDir = Math.round(Math.random()) === 1 ? 1 : -1;
    let leftDir = Math.round(Math.random()) === 1 ? 1 : -1;
    return {c: `form-repeat`, zIndex: -1 * depth, transform: `rotate(${Math.random() * 3 * topDir + 1}deg)`, top: offset * topDir, left: offset * leftDir
      };
  }

  function getDescription(viewId) {
    let description = "No description :(";
    let viewDescription = ixer.selectOne("view description", {view: viewId});
    if(viewDescription) {
      description = viewDescription["view description: description"];
    }
    return description;
  }

  function tableUi(tableId) {
    var view = ixer.selectOne("view", {view: tableId});
    if(!view) return;

    let actions = {
      "back": {text: "Back", func: gotoItemSelector, description: "Return to the item selection page"},
      "new": {text: "New", func: newTableEntry, description: "Create a new entry"},
      "delete": {text: "Delete", func: deleteTableEntry, description: "Delete the current entry"},
      "add field": {text: "+Field", func: addFieldToTable, description: "Add a field to the card"},
      "remove field": {text: "-Field", func: removeFieldFromTable, description: "Remove the active field from the card"},
    };
    let resultViewSize = ixer.select(tableId, {}).length;
    return {c: "query table-editor", children: [
      leftToolbar(actions),
      {c: "container", children: [
        {c: "surface", children: [
          {c: "table-workspace", children: [
            tableFormEditor(tableId, localState.tableEntry, 1, 0),
          ]},
          queryErrors(view),
        ]},
        {id: `${tableId}-results`, c: "query-results", children: [
          {c: "query-results-container", children: [
            {c: "result-size", text: `${resultViewSize} entries`},
            tableEditor.tableForView(tableId, 100, {
              onSelect: selectTableEntry,
              activeRow: localState.selectedTableEntry || localState.tableEntry,
            })
         ]},
        ]},
      ]},
    ]};
  }

  function maybeFocusFormField(e, elem) {
    if(elem.fieldId === localState.focusedTableEntryField) {
      e.focus();
      dispatch("focusTableEntryField", {});
    }
  }

  function selectTableEntry(e, elem) {
    e.stopPropagation();
    dispatch("selectTableEntry", {row: api.clone(elem.row), fieldId: elem.fieldId});
  }

  function keyboardSubmitTableEntry(e, elem) {
    if(e.keyCode === api.KEYS.ENTER) {
      dispatch("submitTableEntry", {});
      e.preventDefault();
    }
  }

  function submitTableEntry(e, elem) {
    dispatch("submitTableEntry", {});
  }

  function clearActiveTableEntryField(e, elem) {
    dispatch("clearActiveTableEntryField", {fieldId: elem.fieldId});
  }

  function activeTableEntryField(e, elem) {
    dispatch("activeTableEntryField", {fieldId: elem.fieldId});
  }

  function setTableEntryField(e, elem) {
    dispatch("setTableEntryField", {fieldId: elem.fieldId, value: coerceInput(e.currentTarget.textContent)});
  }

  function newTableEntry(e, elem) {
    dispatch("newTableEntry", {});
  }

  function deleteTableEntry(e, elem) {
    dispatch("deleteTableEntry", {});
  }

  function addFieldToTable(e, elem) {
    dispatch("addFieldToTable", {});
  }

  function removeFieldFromTable(e, elem) {
    dispatch("removeFieldFromTable", {});
  }

  //---------------------------------------------------------
  // keyboard handling
  //---------------------------------------------------------

  document.addEventListener("keydown", function(e) {
    var KEYS = api.KEYS;
    //Don't capture keys if we're focused on an input of some kind
    var target: any = e.target;
    if(e.defaultPrevented
       || target.nodeName === "INPUT"
       || target.getAttribute("contentEditable")) {
      return;
    }

    //undo + redo
    if((e.metaKey || e.ctrlKey) && e.shiftKey && e.keyCode === KEYS.Z) {
      dispatch("redo", null);
      e.preventDefault();
    } else if((e.metaKey || e.ctrlKey) && e.keyCode === KEYS.Z) {
      dispatch("undo", null);
      e.preventDefault();
    }

    //remove
    if(e.keyCode === KEYS.BACKSPACE) {
      dispatch("removeSelection", null);
      e.preventDefault();
    }

    if((e.ctrlKey || e.metaKey) && e.keyCode === KEYS.F) {
      dispatch("startSearching", {value: ""});
      e.preventDefault();
    }


  });

  //---------------------------------------------------------
  // Go!
  //---------------------------------------------------------

  client.afterInit(() => {
    loadPositions();
    render();
  });
  window["dispatcher"] = {render: render};
}