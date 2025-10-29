import { Workbook } from "../index.js";

const workbook = new Workbook();
workbook.xlsx
  .readFile("./out/template.xlsx")
  .then(stream => {
    const options = {
      useSharedStrings: true,
      useStyles: true
    };

    return stream.xlsx.writeFile("./out/template-out.xlsx", options).then(() => {
      console.log("Done.");
    });
  })
  .catch(error => {
    console.error(error.message);
    console.error(error.stack);
  });
