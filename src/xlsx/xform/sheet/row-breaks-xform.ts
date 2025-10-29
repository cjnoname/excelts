import { PageBreaksXform } from "./page-breaks-xform.js";
import { ListXform } from "../list-xform.js";

class RowBreaksXform extends ListXform {
  constructor() {
    const options = {
      tag: "rowBreaks",
      count: true,
      childXform: new PageBreaksXform()
    };
    super(options);
  }

  // get tag() { return 'rowBreaks'; }

  render(xmlStream: any, model: any): void {
    if (model && model.length) {
      xmlStream.openNode(this.tag, this.$);
      if (this.count) {
        xmlStream.addAttribute(this.$count, model.length);
        xmlStream.addAttribute("manualBreakCount", model.length);
      }

      const { childXform } = this;
      model.forEach((childModel: any) => {
        childXform.render(xmlStream, childModel);
      });

      xmlStream.closeNode();
    } else if (this.empty) {
      xmlStream.leafNode(this.tag);
    }
  }
}

export { RowBreaksXform };
