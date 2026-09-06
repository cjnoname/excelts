/**
 * `DataValidation` namespace surface — sheet data-validation rules.
 *
 * `import { DataValidation } from "documonster/excel"` →
 *   `DataValidation.create()`, `DataValidation.add(dv, "A1", rule)`,
 *   `DataValidation.find(dv, "A1")`, `DataValidation.remove(dv, "A1")`.
 *
 * Cell-level validation (`Cell.getValidation` / `Cell.setValidation`) lives on
 * the `Cell` namespace.
 */
export {
  createDataValidations as create,
  dataValidationAdd as add,
  dataValidationFind as find,
  dataValidationRemove as remove
} from "@excel/core/data-validations";

/** A data-validations handle. */
export type { DataValidationsData as Handle } from "@excel/core/data-validations";
