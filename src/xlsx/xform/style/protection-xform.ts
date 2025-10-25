import { BaseXform } from "../base-xform.js";

const validation = {
  boolean(value: boolean | undefined, dflt: boolean): boolean {
    if (value === undefined) {
      return dflt;
    }
    return value;
  }
};

interface ProtectionModel {
  locked?: boolean;
  hidden?: boolean;
}

// Protection encapsulates translation from style.protection model to/from xlsx
class ProtectionXform extends BaseXform {
  get tag(): string {
    return "protection";
  }

  render(xmlStream: any, model: ProtectionModel): void {
    xmlStream.addRollback();
    xmlStream.openNode("protection");

    let isValid = false;
    function add(name: string, value: string | undefined): void {
      if (value !== undefined) {
        xmlStream.addAttribute(name, value);
        isValid = true;
      }
    }
    add("locked", validation.boolean(model.locked, true) ? undefined : "0");
    add("hidden", validation.boolean(model.hidden, false) ? "1" : undefined);

    xmlStream.closeNode();

    if (isValid) {
      xmlStream.commit();
    } else {
      xmlStream.rollback();
    }
  }

  parseOpen(node: any): void {
    const model: ProtectionModel = {
      locked: !(node.attributes.locked === "0"),
      hidden: node.attributes.hidden === "1"
    };

    // only want to record models that differ from defaults
    const isSignificant = !model.locked || model.hidden;

    this.model = isSignificant ? model : null;
  }

  parseText(): void {}

  parseClose(): boolean {
    return false;
  }
}

export { ProtectionXform };
