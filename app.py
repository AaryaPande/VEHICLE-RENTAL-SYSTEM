
from flask import Flask

app = Flask(__name__)

@app.route("/")
def home():
    return """
    <h1>Vehicle Rental System</h1>
    <p>Welcome to our Vehicle Rental Management System!</p>
    <p>Database-driven vehicle booking and reliability management.</p>
    """

if __name__ == "__main__":
    app.run(debug=True)
