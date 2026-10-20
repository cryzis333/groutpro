-- Позиции «цена по запросу» хранятся с ценой 0: стоимость считается по объекту.
-- Оформить заказ на такую позицию нельзя — это проверяет checkout.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_price_positive;
ALTER TABLE products ADD CONSTRAINT products_price_positive CHECK (price >= 0);
