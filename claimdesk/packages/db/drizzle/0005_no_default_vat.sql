-- The default rate card used to carry 20% VAT although no VAT number is held and CCGUK's contracts state that no VAT
-- is charged. A settings row without a VAT number is set back to 0% (an explicit rate with a VAT number is kept).
UPDATE `settings` SET `rate_card` = json_set(`rate_card`, '$.vatRate', 0) WHERE (`vat_number` IS NULL OR trim(`vat_number`) = '') AND json_extract(`rate_card`, '$.vatRate') > 0;
