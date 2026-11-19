
const express = require("express");
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
    res.send("Bonto Selenium Browser is running!");
});

app.get("/visit", async (req, res) => {
    const url = req.query.url;

    if (!url) {
        return res.status(400).json({
            error: "URL required"
        });
    }

    let parsed;

    try {
        parsed = new URL(url);
    } catch {
        return res.status(400).json({
            error: "Invalid URL"
        });
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
        return res.status(400).json({
            error: "Only HTTP and HTTPS are allowed"
        });
    }

    let driver;

    try {
        const options = new chrome.Options();

        options.addArguments(
            "--headless=new",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--window-size=1365,768"
        );

        driver = await new Builder()
            .forBrowser("chrome")
            .setChromeOptions(options)
            .build();

        await driver.manage().setTimeouts({
            pageLoad: 60000,
            script: 30000
        });

        console.log("Visiting:", url);

        // Open website
        await driver.get(url);

        // Wait for document to finish loading
        await driver.wait(async () => {
            return await driver.executeScript(
                "return document.readyState"
            ) === "complete";
        }, 60000);

        // Wait for body
        await driver.wait(
            until.elementLocated(By.css("body")),
            30000
        );

        // Get fully rendered website
        const result = await driver.executeScript(`
            return {
                title: document.title,
                url: location.href,
                html: document.documentElement.outerHTML,
                text: document.body.innerText,
                readyState: document.readyState,
                userAgent: navigator.userAgent
            };
        `);

        // Screenshot
        const screenshot = await driver.takeScreenshot();

        console.log("Website loaded:", result.title);

        res.json({
            status: "success",
            website: result,
            screenshot: screenshot
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            status: "error",
            message: error.message
        });

    } finally {
        if (driver) {
            await driver.quit();
        }
    }
});

app.listen(3000, () => {
    console.log("Bonto running on port 3000");
});
